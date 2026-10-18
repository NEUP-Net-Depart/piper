import { allowed } from './config';
import { integratedMessage } from './commits';
import { GitHub } from './github';
import { gate, getPR } from './pulls';
import { addressUser } from './mentions';
import { Denied, Retryable, safeText, statusCode, type PR } from './types';

export interface ReleaseRow {
  repo: string; cycle: string; version: string; pr_number: number | null; source_sha: string;
  merge_sha: string | null; state: string; notes: string; error: string | null;
}
export function releaseStatusMessage(gh: GitHub, row: ReleaseRow) {
  const actions = `https://github.com/${gh.repo}/actions/workflows/${encodeURIComponent(gh.config!.release.deploymentWorkflow)}`;
  const states: Record<string, [string, string]> = {
    awaiting_approval: ['等待审查与发布确认', '完成发布 PR 的 CI 和当前提交的人工批准后，由维护者在该 PR 中发送 `/release publish`。'],
    awaiting_deployment: ['已合并，等待部署', `等待部署完成，Piper 会自动检查。[查看部署工作流](${actions})；如果没有运行记录，请维护者检查工作流配置。`],
    ready_to_publish: ['部署已通过，等待创建版本', 'Piper 会自动创建版本 Tag 和 Release，无需重复发送发布命令。'],
    deployment_failed: ['部署未成功', `维护者请[查看部署日志](${actions})，修复并重跑工作流。Piper 会自动重新核验；部署成功前不会创建版本 Tag 和 Release。`],
    published: ['版本已发布', `[查看 Release](https://github.com/${gh.repo}/releases/tag/${encodeURIComponent(row.version)})，无需继续操作。`],
    cancelled: ['发布 PR 已关闭，未合并', '需要继续时，请维护者重新打开该发布 PR，完成最新提交的检查和审查。']
  };
  const [label, action] = states[row.state] ?? ['状态待确认', '请维护者核对发布 PR 和部署工作流。'];
  const pr = row.pr_number ? ` · [PR #${row.pr_number}](https://github.com/${gh.repo}/pull/${row.pr_number})` : '';
  return [`**${safeText(row.version)}：${label}**${pr}`, '', action, ...(row.error ? ['', '<details>', '<summary>失败详情</summary>', '', safeText(row.error), '', '</details>'] : [])].join('\n');
}
export function localTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday!) };
}
export function nextVersion(tags: string[], rule: 'patch' | 'minor' | 'date', initial: string, date: string) {
  if (rule === 'date') return `v${date.split('-').map(Number).join('.')}`;
  const versions = tags.map(t => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)).filter(x => x !== null).map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  versions.sort((a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!);
  const v = versions[0];
  if (!v) return initial;
  return rule === 'minor' ? `v${v[0]}.${v[1]! + 1}.0` : `v${v[0]}.${v[1]}.${v[2]! + 1}`;
}
function ensureRelease(gh: GitHub) {
  if (!allowed(gh.env, gh.repo) || !gh.config!.release.enabled) throw new Denied('该仓库未启用发布，请维护者检查仓库白名单和 release.enabled 配置');
}
function validateReleasePR(gh: GitHub, pr: PR) {
  const c = gh.config!.release;
  if (pr.head.repo?.full_name.toLowerCase() !== gh.repo.toLowerCase() || pr.base.repo.full_name.toLowerCase() !== gh.repo.toLowerCase() || pr.head.ref !== c.source || pr.base.ref !== c.target) throw new Denied('发布 PR 来源、目标或仓库不匹配');
}
interface ReleasePlan { cycle: string; version: string; source_sha: string }
function releasePlan(gh: GitHub, pr: PR): ReleasePlan | null {
  if (pr.user.login !== gh.env.BOT_LOGIN || pr.user.type !== 'Bot') return null;
  const match = /^<!-- piper-release:v1:(\d{4}-\d{2}-\d{2}):(v\d+\.\d+\.\d+):([a-zA-Z0-9]+) -->/.exec(pr.body ?? '');
  return match ? { cycle: match[1]!, version: match[2]!, source_sha: match[3]! } : null;
}
async function notesFor(gh: GitHub, base: string, head: string) {
  const commits = await gh.list('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: base + '...' + head }, 'commits');
  const changes = commits.map(c => '- ' + safeText(c.commit.message.split('\n')[0]).slice(0,250) + ' (' + c.sha.slice(0,7) + ')').join('\n');
  const authors = [...new Set(commits.map(c => safeText(c.author?.login || c.commit.author.name)))].sort().join(', ');
  const notes = '## 变更\n\n' + changes + '\n\n## 贡献者\n\n' + authors + '\n\nhttps://github.com/' + gh.repo + '/compare/' + base + '...' + head;
  if (notes.length > 50000) throw new Denied('Release notes too long; split the release');
  return notes;
}
async function deployment(gh: GitHub, sha: string) {
  const c = gh.config!.release;
  const runs = await gh.list('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', { workflow_id: c.deploymentWorkflow, head_sha: sha, branch: c.target, event: 'push' }, 'workflow_runs');
  const run = runs.filter(r => r.head_sha === sha && r.head_branch === c.target && r.event === 'push').sort((a,b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!run || run.status !== 'completed') return { run, state: 'awaiting_deployment', error: null };
  const jobs = await gh.list('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', { run_id: run.id, attempt_number: run.run_attempt }, 'jobs');
  const deploy = jobs.filter(j => j.name === c.deploymentJob);
  const success = run.conclusion === 'success' && deploy.length === 1 && deploy[0].status === 'completed' && deploy[0].conclusion === 'success' && deploy[0].head_sha === sha;
  return { run, state: success ? 'ready_to_publish' : 'deployment_failed', error: success ? null : 'Workflow ' + run.id + ': ' + (run.conclusion !== 'success' ? run.conclusion : 'Deployment job missing, skipped or unsuccessful') };
}
export async function releaseFor(gh: GitHub, pr: PR): Promise<ReleaseRow | null> {
  const plan = releasePlan(gh, pr);
  if (!plan) return null;
  validateReleasePR(gh, pr);
  const row: ReleaseRow = { repo: gh.repo, ...plan, pr_number: pr.number, merge_sha: pr.merge_commit_sha, notes: '', state: pr.state === 'closed' ? 'cancelled' : 'awaiting_approval', error: null };
  if (pr.merged && pr.merge_commit_sha) {
    try {
      const published = await gh.read('GET /repos/{owner}/{repo}/releases/tags/{tag}', { tag: plan.version });
      const tag = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'tags/' + plan.version });
      if (published.draft || published.author?.login !== gh.env.BOT_LOGIN || tag.object.sha !== pr.merge_commit_sha) throw new Denied('Existing release/tag requires manual reconciliation');
      row.state = 'published';
    } catch (e) {
      if (statusCode(e) !== 404) throw e;
      const info = await deployment(gh, pr.merge_commit_sha); row.state = info.state; row.error = info.error;
    }
  }
  return row;
}
export async function listReleases(gh: GitHub): Promise<ReleaseRow[]> {
  const c = gh.config!.release;
  const prs = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', { state: 'all', head: gh.owner + ':' + c.source, base: c.target, sort: 'created', direction: 'desc' });
  const rows: ReleaseRow[] = [];
  for (const item of prs) {
    if (!releasePlan(gh, item)) continue;
    const row = await releaseFor(gh, await getPR(gh, item.number));
    if (row) rows.push(row);
  }
  return rows;
}
export async function prepareRelease(gh: GitHub, date: Date, force = false): Promise<ReleaseRow | null> {
  ensureRelease(gh);
  const c = gh.config!.release, time = localTime(date,c.timezone);
  if (!force && (time.weekday !== c.weekday || time.hour < c.hour)) return null;
  const rows = await listReleases(gh);
  const existing = rows.find(r => r.cycle === time.date || !['published','cancelled'].includes(r.state));
  if (existing) {
    if (existing.pr_number && existing.state === 'awaiting_approval') await gh.setLabels(existing.pr_number, ['release'], 'release-label:' + existing.cycle);
    return existing;
  }
  const source = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + c.source });
  const target = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + c.target });
  const comparison = await gh.read('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: target.object.sha + '...' + source.object.sha, per_page: 100 });
  if (comparison.ahead_by === 0) return null;
  if (!['ahead','diverged'].includes(comparison.status)) throw new Denied('Release comparison is not ahead');
  const tags = await gh.list('GET /repos/{owner}/{repo}/tags');
  const version = nextVersion([...tags.map(t => t.name), ...rows.map(r => r.version)], c.version, c.initialVersion, time.date);
  if (tags.some(t => t.name === version) || rows.some(r => r.version === version)) throw new Denied('Release version already reserved');
  const notes = await notesFor(gh,target.object.sha,source.object.sha);
  const marker = '<!-- piper-release:v1:' + time.date + ':' + version + ':' + source.object.sha + ' -->';
  const body = marker + '\n' + notes + '\n\n发布需要当前提交的人工批准。维护者使用 /release publish 请求 Merge Commit，部署成功后创建 Tag 和 Release。';
  const pr = await gh.write('release-pr:' + time.date, 'POST /repos/{owner}/{repo}/pulls', { title: 'Release ' + version, head: c.source, base: c.target, body }, async () => {
    const prs = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', { state: 'all', head: gh.owner + ':' + c.source, base: c.target });
    const recovered = prs.find(p => releasePlan(gh,p)?.cycle === time.date);
    if (!recovered && prs.some(p => p.state === 'open')) throw new Denied('已有相同分支的发布 PR，请先处理');
    return recovered;
  });
  if (!pr) return null;
  await gh.setLabels(pr.number, ['release'], 'release-label:' + time.date);
  return releaseFor(gh, await getPR(gh,pr.number));
}
export async function publishRelease(gh: GitHub, number: number, actor: string) {
  return gh.fresh(() => publishCurrentRelease(gh, number, actor));
}
async function publishCurrentRelease(gh: GitHub, number: number, actor: string) {
  ensureRelease(gh);
  if (!(await gh.maintainer(actor))) throw new Denied('发布需要维护者权限');
  const pr = await getPR(gh,number), row = await releaseFor(gh,pr);
  if (!row) throw new Denied('这不是 Piper 创建的发布 PR');
  if (pr.merged && pr.merge_commit_sha) {
    const approval = await gh.getRecord<{ job?: string }>(number, 'release-approval:' + pr.head.sha);
    gh.commandResult = approval?.job === gh.job ? integratedMessage(gh, pr) : `此 PR 已合并。[查看提交](https://github.com/${gh.repo}/commit/${pr.merge_commit_sha})。`;
  }
  if (row.state === 'published') return;
  if (pr.merged) { await syncRelease(gh,row); return; }
  const result = await gate(gh,pr,true);
  if (!result.ready) throw new Denied('发布尚未满足条件：' + result.reasons.join('；'));
  await gh.record(number,'release-approval:' + pr.head.sha, { head: pr.head.sha, actor, reviewers: result.reviewers, version: row.version, job: gh.job });
  const merged = await gh.write('release-merge:' + row.cycle + ':' + pr.head.sha, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { pull_number: number, merge_method: 'merge', sha: pr.head.sha, commit_title: 'Release ' + row.version + ' (#' + number + ')', commit_message: 'Reviewed-by: ' + result.reviewers.join(', ') }, async () => {
    const current = await getPR(gh,number);
    validateReleasePR(gh, current);
    if (current.head.sha !== pr.head.sha) throw new Retryable('Release head changed before merge');
    return current.merged && current.head.sha === pr.head.sha ? { merged: true, sha: current.merge_commit_sha } : undefined;
  });
  if (merged?.merged) gh.commandResult = integratedMessage(gh, pr, merged.sha);
  if (merged && !merged.merged) throw new Retryable('GitHub refused release merge');
  if (merged?.merged) await syncRelease(gh,row);
}
export async function syncRelease(gh: GitHub, row: ReleaseRow) {
  return gh.fresh(() => syncCurrentRelease(gh, row));
}
async function syncCurrentRelease(gh: GitHub, row: ReleaseRow) {
  ensureRelease(gh);
  if (!row.pr_number) return;
  const pr = await getPR(gh,row.pr_number), current = await releaseFor(gh,pr);
  if (!current || !pr.merged || !pr.merge_commit_sha || current.state === 'published') return;
  const commit = await gh.read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: pr.merge_commit_sha });
  if (commit.parents.length !== 2 || commit.parents[1]?.sha !== pr.head.sha) throw new Denied('发布必须使用 Merge Commit，且第二父提交必须匹配 source SHA');
  const receipt = await gh.getRecord<{ head: string; version: string; actor?: string }>(pr.number, 'release-approval:' + pr.head.sha);
  if (!receipt) {
    const approval = await gate(gh,{ ...pr, state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' },true);
    if (!approval.ready || pr.head.sha !== current.source_sha) throw new Denied('手动合并的发布缺少有效批准、CI 或匹配的 source SHA');
  } else if (receipt.head !== pr.head.sha || receipt.version !== current.version) throw new Denied('Release approval receipt mismatch');
  const info = await deployment(gh,pr.merge_commit_sha);
  if (info.state === 'awaiting_deployment') return;
  if (info.state === 'deployment_failed') {
    await gh.comment(pr.number, 'release-failed:' + current.cycle + ':' + info.run.id + ':' + info.run.run_attempt, addressUser(receipt?.actor ? { login: receipt.actor, type: 'User' } : pr.user, '发布部署未成功：' + safeText(info.error!) + '。未创建版本 Tag 或 Release。修复并重跑工作流后会继续核验。')); return;
  }
  const notes = await notesFor(gh,commit.parents[0].sha,pr.head.sha);
  await gh.write('release-tag:' + current.version,'POST /repos/{owner}/{repo}/git/refs',{ ref: 'refs/tags/' + current.version, sha: pr.merge_commit_sha },async () => {
    try {
      const tag = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}',{ ref: 'tags/' + current.version });
      if (tag.object.type !== 'commit' || tag.object.sha !== pr.merge_commit_sha) throw new Denied('版本 Tag 已存在且目标不同，拒绝覆盖');
      return tag;
    } catch(e) { if (statusCode(e) === 404) return undefined; throw e; }
  });
  await gh.write('release-publish:' + current.version,'POST /repos/{owner}/{repo}/releases',{ tag_name: current.version, target_commitish: pr.merge_commit_sha, name: current.version, body: notes, draft: false, prerelease: false, make_latest: 'true' },async () => {
    try {
      const release = await gh.read('GET /repos/{owner}/{repo}/releases/tags/{tag}',{ tag: current.version });
      if (release.draft || release.author?.login !== gh.env.BOT_LOGIN) throw new Denied('Existing release requires manual reconciliation');
      return release;
    } catch(e) { if (statusCode(e) === 404) return undefined; throw e; }
  });
}
