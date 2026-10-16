import { applyPatch, createTwoFilesPatch } from 'diff';
import { GitHub } from './github';
import { Denied, safeText, sha256, statusCode, type PR } from './types';

interface Entry { path: string; mode: string; type: string; sha: string }
async function tree(gh: GitHub, sha: string) {
  const commit = await gh.read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: sha });
  const result = await gh.read('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { tree_sha: commit.tree.sha, recursive: '1' });
  if (result.truncated) throw new Denied('GitHub 返回的文件目录不完整，无法安全地自动移植。请维护者在本地核对变更，手动移植后创建 PR。');
  return { commit, entries: new Map<string, Entry>(result.tree.filter((x: Entry) => x.type !== 'tree').map((x: Entry) => [x.path, x])) };
}
async function blob(gh: GitHub, sha: string) {
  const result = await gh.read('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { file_sha: sha });
  if (result.size > 256000 || result.encoding !== 'base64') throw new Denied('文件超过自动移植的大小限制，或内容编码不受支持');
  const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), x => x.charCodeAt(0));
  if (bytes.includes(0)) throw new Denied('需要合并二进制文件的内容，无法自动按文本补丁处理');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Denied('文件不是 UTF-8 编码，无法自动按文本补丁处理'); }
}
export function applyBackport(before: string, after: string, target: string): string {
  const result = applyPatch(target, createTwoFilesPatch('file', 'file', before, after, '', '', { context: 5 }), { fuzzFactor: 0 });
  if (result === false) throw new Denied('Backport 补丁存在冲突：目标内容与原补丁不兼容');
  return result;
}
export async function backport(gh: GitHub, pr: PR, target: string) {
  if (!gh.config!.backport.enabled || !gh.config!.backport.targets.includes(target) || gh.config!.merge.protectedBranches.includes(target) || target === gh.config!.release.target) throw new Denied('该目标分支不允许 Backport。请维护者检查 .piper.yml 的 backport.enabled 和 backport.targets；保护分支及发布目标不能通过此命令写入。');
  if (!pr.merged || !pr.merge_commit_sha) throw new Denied('命令 /backport 只能用于已合并的 PR。');
  const suffix = (await sha256(target)).slice(0, 12);
  const branch = `piper/backport-${pr.number}-${suffix}`;
  const key = `backport:${pr.number}:${target}:${pr.merge_commit_sha}`;
  const existing = await gh.list('GET /repos/{owner}/{repo}/pulls', { state: 'all', head: `${gh.owner}:${branch}`, base: target });
  if (existing.length) {
    if (existing[0].user?.login !== gh.env.BOT_LOGIN) throw new Denied('同名移植分支已有其他人创建的 PR。请维护者核对该 PR，Piper 不会接管它。');
    return existing[0];
  }
  const source = await tree(gh, pr.merge_commit_sha);
  if (!source.commit.parents[0]) throw new Denied('原提交没有父提交，无法计算要移植的补丁。请维护者在本地核对并手动移植。');
  const before = await tree(gh, source.commit.parents[0].sha);
  const targetRef = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: `heads/${target}` });
  const plan = await gh.record(pr.number, key, { target_sha: targetRef.object.sha });
  const targetSHA = plan?.target_sha ?? targetRef.object.sha;
  const destination = await tree(gh, targetSHA);
  const changed = [...new Set([...before.entries.keys(), ...source.entries.keys()])].filter(p => before.entries.get(p)?.sha !== source.entries.get(p)?.sha || before.entries.get(p)?.mode !== source.entries.get(p)?.mode);
  if (!changed.length || changed.length > gh.config!.backport.maxFiles) throw new Denied(`待移植文件为 ${changed.length} 个，自动移植允许 1–${gh.config!.backport.maxFiles} 个。请维护者确认变更范围，必要时手动移植后创建 PR。`);
  const changes: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] = [];
  for (const path of changed) {
    const old = before.entries.get(path), next = source.entries.get(path), dest = destination.entries.get(path);
    if ([old, next, dest].some(e => e && (e.type !== 'blob' || !['100644','100755'].includes(e.mode)))) throw new Denied('此 Backport 涉及符号链接、子模块或不支持的文件模式，需要人工处理。');
    if (dest?.sha === next?.sha && dest?.mode === next?.mode) continue;
    if (old?.sha === dest?.sha && old?.mode === dest?.mode) changes.push({ path, mode: next?.mode ?? old!.mode, type: 'blob', sha: next?.sha ?? null });
    else if (old && next && dest && old.mode === next.mode && old.mode === dest.mode) {
      try { changes.push({ path, mode: next.mode, type: 'blob', content: applyBackport(await blob(gh, old.sha), await blob(gh, next.sha), await blob(gh, dest.sha)) }); }
      catch (e) {
        if (e instanceof Denied) throw new Denied(`无法自动将 ${pr.merge_commit_sha} 的补丁移植到 ${target}：${e.message.replace(/[。.!]+$/, '')}。请手动移植该合并提交相对第一父提交的补丁，解决冲突后创建 PR。`);
        throw e;
      }
    }
    else throw new Denied(`无法自动将 ${pr.merge_commit_sha} 的补丁移植到 ${target}，文件 ${path} 存在增删或模式冲突。请手动移植该合并提交相对第一父提交的补丁，解决冲突后创建 PR。`);
  }
  if (!changes.length) throw new Denied(`无法再次应用 Backport ${pr.merge_commit_sha}：目标分支 ${target} 已包含这项变更。`);
  const newTree = await gh.write<any>(`${key}:tree`, 'POST /repos/{owner}/{repo}/git/trees', { base_tree: destination.commit.tree.sha, tree: changes }, async () => undefined);
  if (!newTree) return null;
  const commit = await gh.write<any>(`${key}:commit`, 'POST /repos/{owner}/{repo}/git/commits', { message: `Backport #${pr.number}: ${safeText(pr.title)}\n\nBackport-of: ${pr.merge_commit_sha}`, tree: newTree.sha, parents: [targetSHA], author: source.commit.author, committer: { name: 'Piper', email: 'piper@users.noreply.github.com', date: source.commit.committer.date } }, async () => undefined);
  if (!commit) return null;
  await gh.write(`${key}:ref`, 'POST /repos/{owner}/{repo}/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha }, async () => {
    try {
      const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: `heads/${branch}` });
      if (ref.object.sha !== commit.sha) throw new Denied(`移植分支 ${branch} 已存在且指向其他提交。Piper 不会覆盖它，请维护者核对分支后处理。`);
      return ref;
    } catch (e) { if (statusCode(e) === 404) return undefined; throw e; }
  });
  return gh.write(`${key}:pr`, 'POST /repos/{owner}/{repo}/pulls', { title: `Backport #${pr.number}: ${safeText(pr.title)}`, head: branch, base: target, body: `Backport of #${pr.number} (${pr.merge_commit_sha}).\n\n只应用该合并提交相对第一父提交的补丁。需要重新通过 CI 与人工审查。` }, async () => (await gh.list('GET /repos/{owner}/{repo}/pulls', { state: 'all', head: `${gh.owner}:${branch}`, base: target }))[0]);
}
