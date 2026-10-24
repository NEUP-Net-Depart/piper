import type { GitHub } from './github';
import { commitMessage, integratedMessage } from './commits';
import { STATUS_MARKER } from './records';
import { mergeFeedback } from './merging';
import { Denied, Retryable, safeText, sha256, type Gate, type PR, type PRState } from './types';
import { profile, userReference } from './mentions';

const plain = (value: string) => safeText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()|~])/g, '\\$1');
export const READY_MARKER = '<!-- piper:ready -->';
export const PROGRESS_START = '<!-- piper:progress -->';
export const PROGRESS_END = '<!-- piper:progress:end -->';
const INTEGRATED_MARKER = '<!-- piper:integrated -->';
const progressURL = (gh: GitHub, number: number) => `https://github.com/${gh.repo}/pull/${number}#piper-progress`;

function withProgress(body: string, progress: string) {
  const starts = [...body.matchAll(/^<!-- piper:progress -->\r?$/gm)];
  const ends = [...body.matchAll(/^<!-- piper:progress:end -->\r?$/gm)];
  if (starts.length || ends.length) {
    const start = starts[0]?.index, end = ends[0]?.index;
    if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start) {
      throw new Denied('Malformed Piper progress markers; restore the PR description markers before retrying');
    }
    // Remove only our section and its separator; keep author text on both sides.
    const prefix = body.slice(0, start);
    body = prefix.replace(/\r?\n\r?\n$/, '') + body.slice(end + ends[0]![0].length);
  }
  const updated = `${body}${body ? '\n\n' : ''}${PROGRESS_START}\n${progress}\n${PROGRESS_END}`;
  if (updated.length > 65536) throw new Denied('PR description exceeds GitHub body limit; shorten the description before retrying');
  return updated;
}

const revision = (pr: PR) => JSON.stringify([pr.head.sha, pr.head.ref, pr.base.sha, pr.base.ref, pr.title, pr.draft, pr.state, pr.merged, pr.merge_commit_sha]);
function fenced(value: string) {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${value}\n${fence}`;
}

function integrationSteps(gh: GitHub, pr: PR, state: PRState, ready: boolean, policyAuto = false, autoRequestValid = true) {
  const cfg = gh.config!, release = cfg.release.enabled && pr.base.ref === cfg.release.target;
  if (!release && state.merge && (!state.merge.result || state.merge.result.status !== 'merged')) return [mergeFeedback(state.merge)];
  if (release) return ready
    ? ['**维护者**：确认上方提交信息后，在新评论中发送：', '', fenced('/release publish'), '', '使用 Merge Commit 保留提交历史。部署成功后创建版本 Tag 和 Release。']
    : [];
  if (!autoRequestValid && !policyAuto) return ['**自动集成请求无法继续**：请求人已无仓库写权限。请维护者重新发送 `/integrate auto`，或由作者、维护者使用 `/integrate` 手动合并。'];
  if (autoRequestValid && state.integration === 'requested' && state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha) {
    return [`**已开启自动集成**：${ready ? '等待重新核验并合并。' : '条件满足后自动集成。'}无需重复发送命令。`, '', '取消：`/integrate cancel`。推送新提交后须重新请求。'];
  }
  if (policyAuto) return ['**仓库自动集成已启用**，等待核验并合并，无需发送命令。'];
  const lines: string[] = [];
  if (state.integration === 'outdated') lines.push('**旧的集成请求已失效**：完成当前提交的检查和审查后，须重新请求合并。', '');
  if (state.integration === 'cancelled') lines.push('集成请求已取消；准备好后可以重新请求。' + (cfg.merge.auto ? '仓库仍启用了独立的自动集成规则；需要暂停它时，请维护者调整 .piper.yml 中的 merge.auto。' : ''), '');
  if (state.integrate_mode === 'manual' && state.integrate_head === pr.head.sha) lines.push('上次 `/integrate` 只尝试一次，没有登记自动合并。条件满足后须重新发送。', '');
  if (ready) {
    lines.push(`**作者或维护者**：确认上方提交信息后，在新评论中发送：`, '', fenced('/integrate'), '', `使用 Squash 合并至 \`${plain(pr.base.ref)}\`。作者无需仓库写权限。`);
  }
  return lines;
}

async function statusBody(gh: GitHub, pr: PR, state: PRState, result?: Gate) {
  const cfg = gh.config!, release = cfg.release.enabled && pr.base.ref === cfg.release.target;
  const url = `https://github.com/${gh.repo}/pull/${pr.number}`;
  const lines = ['### Piper Progress', ''];
  lines.push(`分支：${plain(pr.head.ref)} → ${plain(pr.base.ref)} · 当前提交：[${pr.head.sha.slice(0, 7)}](https://github.com/${gh.repo}/commit/${pr.head.sha})`, '');
  if (result?.stack?.detail) lines.push(plain(result.stack.detail), '');
  if (pr.merged) {
    lines.push('**已合并**', '');
    const sha = state.merge?.result?.status === 'merged' ? state.merge.result.sha : pr.merge_commit_sha;
    if (sha) lines.push(`合并提交：[${sha.slice(0, 7)}](https://github.com/${gh.repo}/commit/${sha})`, '');
    if (release) lines.push('部署与版本发布状态请在新评论中发送 `/release status` 查询。');
  } else if (pr.state !== 'open') {
    lines.push('**已关闭，未合并**', '', '重新打开 PR 后会检查最新提交的 CI 和审查结果。');
  } else if (result) {
    const policyAuto = !release && cfg.merge.auto && !result.highRisk && await gh.maintainer(pr.user.login);
    const pending = result.progress.filter(p => !p.ready);
    const actions = pending.filter(p => p.action && p.owner !== '等待' && p.owner !== '审查者')
      .sort((a, b) => Number(b.owner === '作者') - Number(a.owner === '作者'));
    const reviews = pending.filter(p => p.owner === '审查者' && p.action);
    const waiting = pending.filter(p => p.owner === '等待');
    const reviewers = [...new Set(pr.requested_reviewers.map(r => r.login))].sort().map(profile).join('、');
    const mergeStatus = state.merge?.result?.status;
    lines.push(state.merge ? mergeStatus === 'failed' ? '**合并失败。**' : mergeStatus === 'unknown' ? '**合并结果暂时无法确认。**' : mergeStatus === 'enqueued' ? '**等待 GitHub Merge Queue。**' : '**正在核实异步合并结果。**'
      : result.ready ? '**检查已满足，等待合并。**' : actions.length ? '**需要处理以下事项。**' : '**等待检查或审查，作者暂时无需操作。**', '');
    if (actions.length) lines.push('#### 需要处理', '', ...actions.map(p => `- **${p.owner ?? '维护者'}**：${plain(p.action!)}`), '');
    if (reviews.length) lines.push('#### 等待处理', '', ...reviews.map(p => `- **审查者** ${reviewers}：${plain(p.action!)} ${plain(p.detail)}。`), '');
    if (waiting.length) lines.push('#### 等待系统检查', '', ...waiting.map(p => `- ${plain(p.name)}：${plain(p.detail)}。`), '');
    if (state.merge) lines.push(mergeFeedback(state.merge), '');
    if (result.ready && !state.merge) {
      const automatic = result.autoRequestValid !== false && !release && state.integration === 'requested' && state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha;
      lines.push(policyAuto ? '**仓库自动集成已启用**，等待核验并合并，无需发送命令。' : automatic ? '**已开启自动集成**，等待核验并合并。取消：`/integrate cancel`。' : `**${release ? '维护者' : '作者或维护者'}**：核对就绪通知中的最终提交信息，在新评论中发送 \`${release ? '/release publish' : '/integrate'}\`。`, '');
      if (release) lines.push('使用 Merge Commit；部署成功后创建版本 Tag 和 Release。', '');
    }
    // Request lifecycle belongs in the status; the ready notice carries the preview.
    if (!state.merge && !policyAuto && (result.autoRequestValid === false || !result.ready || state.integration !== 'requested' || state.integrate_mode !== 'auto')) lines.push(...integrationSteps(gh, pr, state, false, policyAuto, result.autoRequestValid));
    if (result.highRisk) lines.push('', release ? '发布需要当前提交的人工批准和维护者确认。' : '高风险变更：需要当前提交的人工批准和显式集成请求。');
    lines.push('', `[检查详情（CI）](${url}/checks) · [审查意见](${url}/files) · 帮助：\`/help\``, '', '#### 检查进度', '');
    for (const item of result.progress) lines.push(`- [${item.ready ? 'x' : ' '}] ${plain(item.name)}：${plain(item.detail)}`);
    const people = (logins: string[]) => logins.map(profile).join('、') || '暂无';
    lines.push('', '<details>', '<summary>审查详情</summary>', '', `已批准当前提交：${people(result.reviewers)}。`, `等待审查：${people(pr.requested_reviewers.map(r => r.login).sort())}。`);
    if (!pr.draft && pr.requested_reviewers.length) lines.push(`请协助审查 [PR #${pr.number}](${url})；批准请在 GitHub 的 Review changes 中选择 Approve。`);
    for (const review of result.reviewDetails ?? []) {
      if (!result.reviewers.includes(review.login)) {
        const commit = `[${review.sha.slice(0, 7)}](https://github.com/${gh.repo}/pull/${pr.number}/files/${review.sha})`;
        if (review.state === 'APPROVED' && review.sha !== pr.head.sha && result.outdatedReviewers?.includes(review.login)) lines.push(`- ${profile(review.login)} 的批准对应旧提交 ${commit}，未覆盖当前提交 \`${pr.head.sha.slice(0, 7)}\`，该历史批准不代表当前审查任务。`);
        else lines.push(`- ${profile(review.login)}：${plain(({ APPROVED: '已批准，未计入有效批准', CHANGES_REQUESTED: '要求修改', DISMISSED: '审查已撤销' } as Record<string, string>)[review.state] ?? review.state)}，对应 ${commit}。`);
      }
    }
    lines.push('', '</details>');
    if (result.labelRules?.length) lines.push('', '<details>', '<summary>标签与审查规则</summary>', '', '本次修改匹配以下标签与审查规则：', '', ...result.labelRules.map(r => `- \`${plain(r.name)}\`：${plain(r.reason)}；至少 ${r.minimum} 位批准者；审查池：${people(r.reviewers)}。`), '', '维护者可使用 /label add/remove 标签名 调整展示标签，或使用 /label auto 标签名 恢复自动规则；审查要求仍按修改范围计算。', '', '</details>');
    if (cfg.welcome.pr) lines.push('', safeText(cfg.welcome.pr));
    const metadata = state.metadata;
    if (metadata.summary || metadata.author || metadata.contributors?.length || metadata.tag) {
      lines.push('', '<details>', '<summary>合并设置</summary>', '');
      if (metadata.summary) lines.push('提交摘要：', ...metadata.summary.split(/\r?\n/).map(line => '> ' + plain(line)), '');
      if (metadata.author) lines.push(`原作者：${plain(metadata.author.name)}。`);
      if (metadata.contributors?.length) lines.push(`额外贡献者：${metadata.contributors.map(a => plain(a.name)).join('、')}。`);
      if (metadata.tag) lines.push(`合并后 Tag：${plain(metadata.tag)}。`);
      lines.push('', '</details>');
    }
  }
  if (state.metadata.contributors?.length) lines.push('', '#### 贡献者', '', ...state.metadata.contributors.map(a => `- ${plain(a.name)} \`${plain(a.email)}\``), '', '这些信息将用于最终提交署名；按邮箱去重，主作者不重复列为共同作者。');
  if (Object.keys(state.metadata.labels ?? {}).length) lines.push('', '#### 标签调整', '', ...Object.values(state.metadata.labels!).map(l => `- \`${plain(l.name)}\`：${l.mode === 'auto' ? '自动规则' : l.mode === 'add' ? '人工保留' : '人工排除'}。`));
  if (pr.state === 'open') lines.push('', '<details>', '<summary>在本地审查此 PR</summary>', '', '```sh', `git fetch https://github.com/${gh.repo}.git pull/${pr.number}/head:piper-pr-${pr.number}`, `git switch piper-pr-${pr.number}`, '```', '', `[下载 diff](${url}.diff) · [查看文件变更](${url}/files)`, '', '</details>');
  lines.push('', `[参与指南](${cfg.welcome.guide})`);
  return lines.join('\n');
}

export async function summarize(gh: GitHub, pr: PR, state: PRState, result?: Gate) {
  const progress = await statusBody(gh, pr, state, result);
  const current = await gh.read<PR>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number });
  if (revision(current) !== revision(pr)) throw new Retryable('PR changed during progress refresh');
  const body = withProgress(current.body ?? '', progress);
  if (body !== current.body) {
    await gh.write(`progress:${pr.number}:${await sha256(body)}`, 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number, body }, async () => {
      const latest = await gh.read<PR>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number });
      if (revision(latest) !== revision(current)) throw new Retryable('PR changed during progress update');
      if (latest.body === body) return latest;
      if (latest.body !== current.body) throw new Retryable('PR description changed during progress update');
      return undefined;
    });
  }
  await gh.managedComment(pr.number, STATUS_MARKER, `[查看 PR 描述中的协作进度](${progressURL(gh, pr.number)})。`);
}

export async function integrationNotice(gh: GitHub, pr: PR, state: PRState, result?: Gate) {
  const comments = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: pr.number });
  const existing = comments.find(c => c.user?.login === gh.env.BOT_LOGIN && c.user?.type === 'Bot' && c.body?.startsWith(READY_MARKER));
  const link = progressURL(gh, pr.number);
  if (!result?.ready || pr.state !== 'open' || state.merge && !pr.merged) {
    const pending = [state.merge ? mergeFeedback(state.merge) : '当前尚未满足合并条件，请查看协作进度。', '', `[查看待处理事项与检查进度](${link})。`, '', ...(state.merge ? [] : integrationSteps(gh, pr, state, false, false, result?.autoRequestValid))].join('\n').trimEnd();
    if (existing && !(pr.merged && state.merge && !state.merge.intent.replyJob)) await gh.managedComment(pr.number, READY_MARKER, pr.merged ? `此 PR 已合并。[查看结果](${link})。` : pr.state !== 'open' ? `此 PR 已关闭，未合并。[查看状态](${link})。` : pending);
    const sha = state.merge?.result?.status === 'merged' ? state.merge.result.sha : !state.merge ? pr.merge_commit_sha : null;
    if (pr.merged && sha) {
      const message = integratedMessage(gh, pr, sha);
      const job = state.release_job ?? (state.merge ? state.merge.intent.replyJob : state.integrate_job);
      if (job) await gh.replyFor(pr.number, job, message, state.release_job ? state.release_actor : state.merge?.intent.actor ?? state.integrate_actor ?? undefined);
      else await gh.managedComment(pr.number, state.merge ? READY_MARKER : INTEGRATED_MARKER, message);
    }
    return;
  }
  const cfg = gh.config!, release = cfg.release.enabled && pr.base.ref === cfg.release.target;
  let preview: string;
  if (release) {
    const version = /^<!-- piper-release:v1:\d{4}-\d{2}-\d{2}:(v\d+\.\d+\.\d+):/.exec(pr.body ?? '')?.[1];
    if (!version || pr.user.login !== gh.env.BOT_LOGIN || pr.user.type !== 'Bot' || pr.head.ref !== cfg.release.source || pr.head.repo?.full_name.toLowerCase() !== gh.repo.toLowerCase()) return;
    preview = `Release ${version} (#${pr.number})\n\nReviewed-by: ${result.reviewers.join(', ')}`;
  } else {
    const commits = await gh.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { pull_number: pr.number });
    if (commits.length >= 250) {
      await gh.managedComment(pr.number, READY_MARKER, `提交数量达到 GitHub 的 250 条读取上限，Piper 无法确认完整的最终提交信息。请维护者拆分 PR 或人工核对完整提交清单后处理合并。[查看协作进度](${link})。`);
      return;
    }
    const message = commitMessage(pr, state.metadata, result.reviewers, commits.filter(c => c.commit.author).map(c => ({ ...c.commit.author, login: c.author?.login })));
    preview = [message.commit_title, message.commit_message].filter(Boolean).join('\n\n');
  }
  const author = userReference(pr.user, true);
  const command = (name: string) => `\`${name}\``;
  const method = release ? 'Merge Commit' : 'Squash';
  const lines = [`${author} 当前提交 \`${pr.head.sha.slice(0, 7)}\` 已满足 CI 和审查要求。`, '', `合并到 \`${plain(pr.base.ref)}\` 的最终提交信息：`, '', fenced(preview), '', ...integrationSteps(gh, pr, state, true, !release && cfg.merge.auto && !result.highRisk && await gh.maintainer(pr.user.login), result.autoRequestValid), '', `合并前请确认项目要求的其他人工检查已完成，详见[参与指南](${cfg.welcome.guide})。`, '', '<details>', '<summary>提交说明与目标分支变化</summary>', ''];
  if (!release) lines.push(`可以使用 ${command('/summary')} 调整提交摘要，由维护者使用 ${command('/contributor')} 和 ${command('/author')} 调整署名。`, '');
  const comparison = await gh.read('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${pr.head.sha}...${pr.base.sha}` });
  const count = Number(comparison.ahead_by) || 0;
  const commits = (comparison.commits ?? []).slice(0, 3);
  const compare = `https://github.com/${gh.repo}/compare/${pr.head.sha}...${pr.base.sha}`;
  lines.push(`本条评论更新时，目标分支 \`${plain(pr.base.ref)}\` 相对当前 PR 的共同祖先新增了 ${count} 个提交：`, '');
  for (const commit of commits) lines.push(`- [${commit.sha.slice(0, 7)}](https://github.com/${gh.repo}/commit/${commit.sha})：${plain(commit.commit.message.split('\n')[0])}`);
  if (count > commits.length) lines.push(`- ……还有 ${count - commits.length} 个提交：[查看完整比较](${compare})。`);
  else lines.push(`[查看完整比较](${compare})。`);
  lines.push('', `当前没有合并冲突。Piper 将通过 ${method} 集成上述修改，执行前会再次核验当前提交、CI、人工批准和分支规则。`, '', `当前提交：\`${pr.head.sha}\`。`, '', '</details>', '', `[查看协作进度](${link}) · 在新评论中发送 ${command(release ? '/help release' : '/help integrate')} 查看命令用法。`);
  await gh.managedComment(pr.number, READY_MARKER, lines.join('\n'));
}
