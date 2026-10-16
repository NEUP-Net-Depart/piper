import type { GitHub } from './github';
import { commitMessage, integratedMessage } from './commits';
import { STATUS_MARKER } from './records';
import { safeText, type Gate, type PR, type PRState } from './types';
import { profile, userReference } from './mentions';

const plain = (value: string) => safeText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()|~])/g, '\\$1');
export const READY_MARKER = '<!-- piper:ready -->';
const INTEGRATED_MARKER = '<!-- piper:integrated -->';
function fenced(value: string) {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${value}\n${fence}`;
}

function integrationSteps(gh: GitHub, pr: PR, state: PRState, ready: boolean) {
  const cfg = gh.config!, release = cfg.release.enabled && pr.base.ref === cfg.release.target;
  if (release) return ready
    ? ['**维护者**：确认集成提示中的最终提交信息后，在新评论中发送：', '', fenced('/release publish'), '', '此 PR 使用 Merge Commit（保留提交历史）。合并后还要等待部署成功，Piper 才会创建版本 Tag 和 Release。']
    : ['**维护者**：在 Piper 创建的发布 PR 中完成检查并获得当前提交的人工批准后，再确认发布。'];
  if (state.integration === 'requested' && state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha) {
    return [`**已开启自动集成**：${profile(state.integrate_actor!)} 请求合并当前提交。${ready ? 'Piper 将重新核验并尝试 Squash 合并。' : '条件满足后自动集成。'}无需重复发送命令。`, '', '要取消这次请求，在新评论中发送 `/integrate cancel`。推送新提交会使本次请求失效。'];
  }
  const lines: string[] = [];
  if (state.integration === 'outdated') lines.push('**旧的集成请求已失效**：PR 有了新提交。完成最新提交的检查和审查后，须重新请求合并。', '');
  if (state.integration === 'cancelled') lines.push('集成请求已取消；准备好后可以重新请求。' + (cfg.merge.auto ? '仓库仍启用了独立的自动集成规则；需要暂停它时，请维护者调整 .piper.yml 中的 merge.auto。' : ''), '');
  if (state.integrate_mode === 'manual' && state.integrate_head === pr.head.sha) lines.push('上次 `/integrate` 只尝试一次，没有登记自动合并。条件满足后须重新发送。', '');
  if (ready) {
    if (cfg.merge.auto) lines.push('仓库已启用自动集成：有写权限作者的非高风险 PR 会由 Piper 再次核验后合并。', '');
    lines.push(`**作者或维护者**：确认集成提示中的最终提交信息后，在新评论中发送以下命令，将修改合并到 \`${plain(pr.base.ref)}\`：`, '', fenced('/integrate'), '', '普通 PR 使用 Squash（将本次修改合成一个提交）。作者无需仓库写权限。');
  }
  return lines;
}

function statusBody(gh: GitHub, pr: PR, state: PRState, result?: Gate) {
  const cfg = gh.config!, release = cfg.release.enabled && pr.base.ref === cfg.release.target;
  const url = `https://github.com/${gh.repo}/pull/${pr.number}`;
  const lines = ['### Piper 协作状态', ''];
  if (pr.state === 'open' && cfg.welcome.pr) lines.push(safeText(cfg.welcome.pr), '');
  lines.push(`分支：${plain(pr.head.ref)} → ${plain(pr.base.ref)} · 当前提交：[${pr.head.sha.slice(0, 7)}](https://github.com/${gh.repo}/commit/${pr.head.sha})`, '');
  if (pr.merged) {
    lines.push('**已合并**', '');
    if (pr.merge_commit_sha) lines.push(`合并提交：[${pr.merge_commit_sha.slice(0, 7)}](https://github.com/${gh.repo}/commit/${pr.merge_commit_sha})`, '');
    if (release) lines.push('部署与版本发布状态请在新评论中发送 `/release status` 查询。');
  } else if (pr.state !== 'open') {
    lines.push('**已关闭，未合并**', '', '重新打开 PR 后会检查最新提交的 CI 和审查结果。');
  } else if (result) {
    lines.push(result.ready ? '✅ **检查已满足，等待合并。**' : '⏳ **还有事项待完成。**', '', '#### 接下来做什么', '');
    for (const item of result.progress.filter(p => !p.ready && p.action)) lines.push(`- ${item.owner ? `**${item.owner}**：` : ''}${plain(item.action!)}`);
    lines.push('', ...integrationSteps(gh, pr, state, result.ready));
    if (result.highRisk) lines.push('', release ? '🔒 发布需要当前提交的人工批准和维护者确认。' : '🔒 此 PR 涉及高风险变更，需要当前提交的人工批准和显式集成请求。');
    lines.push('', `[检查详情（CI）](${url}/checks) · [查看审查意见](${url}/files) · 在新评论中发送 \`/help\` 查看帮助。`, '', '<details>', '<summary>检查进度与审查详情</summary>', '', 'CI 指自动构建和测试；每次推送新提交后重新检查。', '', '#### 检查进度', '');
    for (const item of result.progress) lines.push(`- [${item.ready ? 'x' : ' '}] ${plain(item.name)}：${plain(item.detail)}`);
    const people = (logins: string[]) => logins.map(profile).join('、') || '暂无';
    lines.push('', '#### 审查者', '', `已批准当前提交：${people(result.reviewers)}。`, `等待审查：${people(pr.requested_reviewers.map(r => r.login).sort())}。`);
    if (!pr.draft && pr.requested_reviewers.length) lines.push(`请协助审查 [PR #${pr.number}](${url})；批准请在 GitHub 的 Review changes 中选择 Approve。`);
    for (const review of result.reviewDetails ?? []) {
      if (!result.reviewers.includes(review.login)) {
        const commit = `[${review.sha.slice(0, 7)}](https://github.com/${gh.repo}/pull/${pr.number}/files/${review.sha})`;
        if (review.state === 'APPROVED' && review.sha !== pr.head.sha) lines.push(`- ${profile(review.login)} 的批准对应旧提交 ${commit}，未覆盖当前提交 \`${pr.head.sha.slice(0, 7)}\`。请审查最新代码并重新提交 Approve。`);
        else lines.push(`- ${profile(review.login)}：${plain(({ APPROVED: '已批准，未计入有效批准', CHANGES_REQUESTED: '要求修改', DISMISSED: '审查已撤销' } as Record<string, string>)[review.state] ?? review.state)}，对应 ${commit}。`);
      }
    }
    lines.push('', '</details>');
    if (result.labelRules?.length) lines.push('', '<details>', '<summary>标签与审查规则</summary>', '', '本次修改匹配以下标签与审查规则：', '', ...result.labelRules.map(r => `- \`${plain(r.name)}\`：${plain(r.reason)}；至少 ${r.minimum} 位批准者；审查池：${people(r.reviewers)}。`), '', '维护者可使用 /label add/remove 标签名 调整展示标签，或使用 /label auto 标签名 恢复自动规则；审查要求仍按修改范围计算。', '', '</details>');
    lines.push('', '修改代码时，继续推送到当前 PR 的源分支即可；新提交需要重新获得批准。');
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
  await gh.managedComment(pr.number, STATUS_MARKER, statusBody(gh, pr, state, result));
}

export async function integrationNotice(gh: GitHub, pr: PR, state: PRState, result?: Gate) {
  const comments = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: pr.number });
  const existing = comments.find(c => c.user?.login === gh.env.BOT_LOGIN && c.user?.type === 'Bot' && c.body?.startsWith(READY_MARKER));
  const status = comments.find(c => c.user?.login === gh.env.BOT_LOGIN && c.user?.type === 'Bot' && c.body?.startsWith(STATUS_MARKER));
  const link = `https://github.com/${gh.repo}/pull/${pr.number}` + (status ? `#issuecomment-${status.id}` : '');
  if (!result?.ready || pr.state !== 'open') {
    const pending = [`${userReference(pr.user, true)} 此修改目前尚未满足集成条件。请查看[协作进度中的“接下来做什么”](${link})。`, '', ...integrationSteps(gh, pr, state, false)].join('\n').trimEnd();
    if (existing || pr.state === 'open') await gh.managedComment(pr.number, READY_MARKER, pr.merged ? `此 PR 已集成。[查看结果](${link})。` : pr.state !== 'open' ? `此 PR 已关闭，未合并。[查看状态](${link})。重新打开后会检查最新提交的 CI 和审查结果。` : pending);
    if (pr.merged && pr.merge_commit_sha) {
      const message = integratedMessage(gh, pr);
      const job = state.release_job ?? state.integrate_job;
      if (job) await gh.replyFor(pr.number, job, message, state.release_job ? state.release_actor : state.integrate_actor ?? undefined);
      else await gh.managedComment(pr.number, INTEGRATED_MARKER, message);
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
  const lines = [`${author} 此变更已通过所有自动集成前检查，当前提交的人工批准也已满足。`, '', ...integrationSteps(gh, pr, state, true), '', `合并到 \`${plain(pr.base.ref)}\` 的最终提交信息：`, '', fenced(preview), '', '<details>', '<summary>提交说明与目标分支变化</summary>', '', `ℹ️ 项目也有需要人工确认的要求，详见[项目参与指南](${cfg.welcome.guide})。`, ''];
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
