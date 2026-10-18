import { matches } from './config';
import { commitMessage, integratedMessage } from './commits';
import { GitHub } from './github';
import { reviewPolicy, syncLabels } from './labels';
import { prState } from './records';
import { integrationNotice, summarize } from './status';
import { addressUser } from './mentions';
import { Denied, Retryable, epoch, safeText, type Gate, type PR, type PRState, type Progress, type Review } from './types';
export { commitMessage } from './commits';

export const getPR = async (gh: GitHub, number: number) => gh.observePR(await gh.read<PR>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number }));
export const filesFor = (gh: GitHub, number: number) => gh.list<{ filename: string; previous_filename?: string; status: string }>('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { pull_number: number });
export const reviewsFor = (gh: GitHub, number: number) => gh.list<Review>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { pull_number: number });

const CI_STARTUP_GRACE_MS = 5 * 60 * 1000;
async function observedHeadAt(gh: GitHub, pr: PR) {
  const key = 'ci-head-seen:' + pr.head.sha;
  const saved = await gh.getRecord<{ at: number }>(pr.number, key);
  if (saved) {
    if (!Number.isFinite(saved.at) || saved.at < 0) throw new Denied('Invalid CI head observation record');
    return saved.at;
  }
  const at = Date.now();
  if (pr.state === 'open') return (await gh.record(pr.number, key, { at }))?.at ?? at;
  return at;
}
async function checkProgress(gh: GitHub, sha: string, required: string[], observedAt?: number) {
  const appIds = gh.config!.merge.trustedCheckAppIds;
  if (!appIds.length) return {
    reasons: ['未配置可信 CI 应用'], missing: false,
    progress: [{ name: 'CI 来源', ready: false, detail: '尚未配置可信检查来源', owner: '维护者' as const,
      action: '在 .piper.yml 的 merge.trustedCheckAppIds 中配置实际 CI 应用的 app.id；仅检查名称相同不足以确认来源。' }]
  };
  const awaitingStartup = observedAt !== undefined && Date.now() < observedAt + CI_STARTUP_GRACE_MS;
  const runs = await gh.list('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ref: sha, filter: 'latest' }, 'check_runs');
  const reasons: string[] = [], progress: Progress[] = [];
  let anyMissing = false;
  for (const name of required) {
    const relevant = runs.filter(r => r.name === name && r.name !== 'Piper' && appIds.includes(r.app?.id));
    const latest = new Map<number, any>();
    for (const run of relevant) if ((latest.get(run.app?.id)?.id ?? 0) < run.id) latest.set(run.app?.id, run);
    const current = [...latest.values()];
    const missing = !latest.size;
    anyMissing ||= missing;
    const failed = current.some(r => r.head_sha !== sha || (r.status === 'completed' && r.conclusion !== 'success'));
    const pending = current.some(r => r.status !== 'completed');
    if (missing) reasons.push(`CI 缺失：${name}`);
    else if (failed || pending) reasons.push(`CI 未成功：${name}`);
    progress.push({ name: `CI · ${name}`, ready: !missing && !failed && !pending,
      detail: missing ? awaitingStartup ? '等待 CI 启动（首次观察到当前提交后 5 分钟内）' : '尚未收到当前提交的必需检查' : failed ? '检查未通过' : pending ? '检查正在排队或运行' : '当前提交检查通过',
      owner: missing ? awaitingStartup ? '等待' : '维护者' : failed ? '作者' : '等待',
      action: missing ? awaitingStartup ? undefined : `在 Checks 中确认 ${name} 已启动；没有运行记录时检查工作流配置和运行权限。` : failed ? `打开 Checks 中的 ${name} 查看日志，修复后推送到当前分支；同一 PR 会自动更新。` : pending ? `等待 ${name} 运行结束。` : undefined });
  }
  return { reasons, progress, missing: anyMissing };
}
export async function checks(gh: GitHub, sha: string, required: string[]): Promise<string[]> {
  return (await checkProgress(gh, sha, required)).reasons;
}
export async function gate(gh: GitHub, pr: PR, release = false, changedFiles?: Awaited<ReturnType<typeof filesFor>>): Promise<Gate> {
  const cfg = gh.config!;
  const headSeenAt = await observedHeadAt(gh, pr);
  const state = await prState(gh, pr);
  const autoRequestValid = !(state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha) || !!state.integrate_actor && await gh.maintainer(state.integrate_actor);
  const reasons: string[] = [], progress: Progress[] = [];
  if (pr.state !== 'open' || pr.merged) reasons.push('PR 已关闭或合并');
  if (pr.draft) reasons.push('PR 仍为草稿');
  progress.push({ name: '准备审查', ready: !pr.draft, detail: pr.draft ? '仍为草稿' : '已标记为可审查', owner: '作者', action: pr.draft ? '代码准备好后，点击 PR 页面上的 Ready for review，开始正式审查。' : undefined });
  if (pr.mergeable !== true) reasons.push(pr.mergeable === null ? 'GitHub 尚未完成冲突检查' : '存在合并冲突');
  progress.push({ name: '合并冲突', ready: pr.mergeable === true, detail: pr.mergeable === null ? 'GitHub 正在检查' : pr.mergeable ? '没有冲突' : '存在冲突', owner: pr.mergeable === null ? '等待' : '作者', action: pr.mergeable === null ? '等待 GitHub 完成冲突检查。' : !pr.mergeable ? '将目标分支的最新代码合入当前分支，解决冲突后推送到同一 PR。' : undefined });
  if (!['clean', 'unstable', 'has_hooks'].includes(pr.mergeable_state)) reasons.push(`GitHub 合并状态：${pr.mergeable_state}`);
  progress.push({ name: 'GitHub 分支规则', ready: ['clean', 'unstable', 'has_hooks'].includes(pr.mergeable_state), detail: ['clean', 'unstable', 'has_hooks'].includes(pr.mergeable_state) ? 'GitHub 允许继续核验 CI 和审查' : `等待满足 GitHub 要求（${pr.mergeable_state}）`, owner: '维护者', action: pr.mergeable === null ? undefined : '查看 PR 页面底部的合并区域，按提示补齐分支保护要求。' });
  const targetStart = reasons.length;
  if (release && (pr.base.ref !== cfg.release.target || pr.head.ref !== cfg.release.source || pr.head.repo?.full_name.toLowerCase() !== gh.repo.toLowerCase() || pr.user.login !== gh.env.BOT_LOGIN || pr.user.type !== 'Bot' || !/^<!-- piper-release:v1:\d{4}-\d{2}-\d{2}:v\d+\.\d+\.\d+:[a-zA-Z0-9]+ -->/.test(pr.body ?? ''))) reasons.push('请使用 Piper 创建的发布 PR');
  if (!release && (!cfg.merge.allowedBases.includes(pr.base.ref) || cfg.merge.protectedBranches.includes(pr.base.ref))) reasons.push(`目标分支 ${pr.base.ref} 不允许普通集成。普通贡献可使用：${cfg.merge.allowedBases.filter(b => !cfg.merge.protectedBranches.includes(b) && b !== cfg.release.target).join('、') || '暂无可用分支'}。`);
  if (!release && pr.base.ref === cfg.release.target) reasons.push('发布目标分支必须使用发布流程');
  progress.push({ name: '目标分支', ready: reasons.length === targetStart, detail: pr.base.ref, owner: '维护者', action: release ? '使用 /release prepare 创建发布 PR，再到该 PR 完成检查并发布。' : `确认 PR 的目标分支；普通贡献使用 ${cfg.merge.allowedBases.filter(b => !cfg.merge.protectedBranches.includes(b) && b !== cfg.release.target).join('、') || '仓库配置允许的分支'}。` });
  const files = changedFiles ?? await filesFor(gh, pr.number);
  // GitHub caps PR files at 3,000. Never treat a capped response as complete.
  if (files.length >= 3000) {
    reasons.push('文件数量达到 GitHub 上限，需要人工处理');
    progress.push({ name: '变更范围', ready: false, detail: '文件数量达到 GitHub 上限', owner: '维护者', action: '拆分变更或人工处理文件清单。' });
  }
  const policy = reviewPolicy(cfg, pr, files, state.metadata);
  const highRisk = release || policy.highRisk || files.some(f => cfg.merge.highRiskFiles.some(p => matches(p, f.filename) || (f.previous_filename && matches(p, f.previous_filename)))) || pr.labels.some(l => cfg.merge.highRiskLabels.includes(l.name));
  const reviews = await reviewsFor(gh, pr.number);
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login.toLowerCase(), review);
  }
  const approved: string[] = [], requestedChanges: string[] = [], outdated: string[] = [];
  for (const review of latest.values()) {
    if (review.user.login.toLowerCase() === pr.user.login.toLowerCase() || review.user.type === 'Bot') continue;
    if (!(await gh.maintainer(review.user.login))) continue;
    if (review.state === 'CHANGES_REQUESTED') { reasons.push(`${review.user.login} 要求修改`); requestedChanges.push(review.user.login); }
    if (review.state === 'APPROVED' && review.commit_id === pr.head.sha) approved.push(review.user.login);
    if (review.state === 'APPROVED' && review.commit_id !== pr.head.sha) outdated.push(review.user.login);
  }
  const minimum = release ? Math.max(cfg.release.minApprovals, policy.minimum) : policy.minimum;
  if (approved.length < minimum) reasons.push(`当前提交需要至少 ${minimum} 位有仓库写权限的人工审查者批准，目前已有 ${approved.length} 位。PR 作者和 Bot 不计入批准人数。`);
  progress.push({ name: '人工审查', ready: approved.length >= minimum && !requestedChanges.length,
    detail: `当前提交已获 ${approved.length}/${minimum} 位审查者批准${requestedChanges.length ? `；${requestedChanges.join('、')} 要求修改` : ''}${outdated.length ? `；${outdated.join('、')} 的批准对应旧提交` : ''}`,
    owner: requestedChanges.length ? '作者' : pr.requested_reviewers.length ? '审查者' : '维护者',
    action: requestedChanges.length ? '按 Files changed 中的审查意见修改并推送，再请审查者重新审查；普通回复不会解除“要求修改”。' : pr.draft ? undefined : pr.requested_reviewers.length ? '在 Files changed → Review changes 中提交批准或修改意见。' : '当前没有待处理的审查请求。用 /reviewers add 用户名 邀请审查者，或在 GitHub 的 Reviewers 中选择。' });
  const ci = await checkProgress(gh, pr.head.sha, release ? cfg.release.requiredChecks : cfg.merge.requiredChecks, headSeenAt);
  reasons.push(...ci.reasons); progress.push(...ci.progress);
  if (ci.missing && Date.now() < headSeenAt + CI_STARTUP_GRACE_MS && pr.state === 'open') {
    gh.ciStartupRefreshes.set(pr.number, { head: pr.head.sha, at: headSeenAt + CI_STARTUP_GRACE_MS });
  } else gh.ciStartupRefreshes.delete(pr.number);
  if (!release) {
    const commits = await gh.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { pull_number: pr.number });
    if (commits.length >= 250) {
      reasons.push('提交数量达到 GitHub 的 250 条读取上限');
      progress.push({ name: '提交信息', ready: false, detail: '提交数量达到 GitHub 的 250 条读取上限，无法确认完整预览和署名', owner: '维护者', action: '拆分 PR，或人工核对完整提交清单后处理合并。Piper 不会执行本次集成。' });
    }
  }
  // Explain known blockers without changing GitHub's merge gate.
  const branch = progress.find(p => p.name === 'GitHub 分支规则')!;
  if (pr.mergeable_state === 'dirty') {
    branch.detail = '存在合并冲突，解决后重新核对 GitHub 分支规则';
    const conflict = progress.find(p => p.name === '合并冲突')!;
    // The conflict row already tells the author what to do; keep this row in details.
    branch.owner = conflict.owner === '作者' && !conflict.ready ? undefined : '作者';
    branch.action = branch.owner ? '将目标分支的最新代码合入当前分支，解决冲突后推送到同一 PR。' : undefined;
  } else if (pr.mergeable_state === 'behind') {
    branch.owner = '作者';
    branch.detail = '当前分支落后于目标分支，需要同步后重新检查';
    branch.action = '将目标分支的最新代码同步到当前分支并推送，等待新提交的检查和审查。';
  } else if (!branch.ready && (pr.mergeable === null || (pr.mergeable_state === 'blocked' && (ci.reasons.length > 0 || approved.length < minimum || requestedChanges.length > 0)))) {
    // Specific check/review rows carry the action or wait; retain the aggregate only in details.
    branch.owner = undefined;
    branch.detail = pr.mergeable === null ? '等待 GitHub 完成冲突检查后重新核对分支规则' : '已知检查或审查尚未完成，完成后重新核对 GitHub 分支规则';
    branch.action = undefined;
  }
  if (policy.rules.length) progress.push({ name: '模块审查要求', ready: approved.length >= minimum, detail: `${policy.rules.map(r => r.name).join('、')}；至少 ${minimum} 位批准者` });
  const labelRules = policy.rules.map(rule => ({ name: rule.name, minimum: Math.max(cfg.merge.minApprovals, rule.minApprovals ?? 0), reviewers: rule.reviewers.length ? rule.reviewers : cfg.reviewers.pool,
    reason: [rule.titlePrefixes.some(p => pr.title.toLowerCase().startsWith(p.toLowerCase())) ? '标题前缀匹配' : '', rule.branches.some(p => matches(p, pr.head.ref)) ? `源分支 ${pr.head.ref}` : '', ...files.filter(f => rule.files.some(p => matches(p, f.filename) || (f.previous_filename && matches(p, f.previous_filename)))).slice(0, 3).map(f => `文件 ${f.filename}${f.previous_filename ? `（原路径 ${f.previous_filename}）` : ''}`)].filter(Boolean).join('；') }));
  return { ready: !reasons.length, reasons, reviewers: approved.sort(), outdatedReviewers: outdated.sort(), autoRequestValid, highRisk, progress, labelRules, reviewDetails: [...latest.values()].map(r => ({ login: r.user.login, sha: r.commit_id, state: r.state })) };
}
export async function integrate(gh: GitHub, number: number, actor: string, expected: string, automatic = false, policyAuto = false) {
  return gh.fresh(() => integrateCurrent(gh, number, actor, expected, automatic, policyAuto));
}
async function integrateCurrent(gh: GitHub, number: number, actor: string, expected: string, automatic: boolean, policyAuto: boolean) {
  let pr = await getPR(gh, number);
  if (pr.merged) {
    const previous = await prState(gh, pr), metadata = previous.metadata;
    if (metadata.tag) await tagPR(gh, pr, metadata.tag);
    gh.commandResult = previous.integrate_job === gh.job ? integratedMessage(gh, pr) : `此 PR 已合并。[查看提交](https://github.com/${gh.repo}/commit/${pr.merge_commit_sha})。`;
    return true;
  }
  if (pr.head.sha !== expected) throw new Denied('PR 已更新，旧的集成请求已失效。请完成新提交的检查与审查，再发送 /integrate。');
  const target = pr.base.ref;
  const maintainer = await gh.maintainer(actor);
  if (actor.toLowerCase() !== pr.user.login.toLowerCase() && !maintainer) throw new Denied('集成需要 PR 作者或仓库维护者执行。维护者须具有 write、maintain 或 admin 权限。');
  const state = await prState(gh, pr);
  if ((automatic || state.integrate_mode === 'auto') && !maintainer) throw new Denied('自动集成需要当前仍有仓库 write、maintain 或 admin 权限。');
  const result = await gate(gh, pr);
  if (policyAuto && result.highRisk) return false;
  if (!result.ready) {
    if (!automatic) gh.commandResult = (state.integrate_mode === 'auto' ? '此 PR 将在以下条件满足后自动集成：' : '无法执行 `/integrate`：') + '\n' + result.reasons.map(x => `- ${safeText(x)}`).join('\n') + (state.integrate_mode === 'auto' ? '\n\n新提交会使本次请求失效；可用 `/integrate manual` 或 `/integrate cancel` 取消。' : '\n\n条件满足后请重新发送 `/integrate`；如需等待当前提交自动集成，可由有写权限的作者或维护者使用 `/integrate auto`。');
    return false;
  }
  const commits = await gh.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { pull_number: number });
  if (commits.length >= 250) throw new Denied('提交数量达到 GitHub 的 250 条读取上限，无法确认完整署名。请维护者拆分 PR 或人工核对完整提交清单后处理合并。');
  const authors = commits.filter(c => c.commit.author).map(c => ({ ...c.commit.author, login: c.author?.login }));
  const metadata = state.metadata;
  pr = await getPR(gh, number);
  if (pr.head.sha !== expected) throw new Retryable('Head changed during integration');
  if (pr.base.ref !== target) throw new Retryable('Target branch changed during integration');
  const message = commitMessage(pr, metadata, result.reviewers, authors);
  const merged = await gh.write(`integrate:${number}:${expected}`, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { pull_number: number, merge_method: 'squash', sha: expected, ...message }, async () => {
    const current = await getPR(gh, number);
    if (current.base.ref !== target || (!current.merged && current.head.sha !== expected)) throw new Retryable('PR changed before integration');
    return current.merged && current.head.sha === expected ? { merged: true, sha: current.merge_commit_sha } : undefined;
  });
  if (merged && !merged.merged) throw new Retryable('GitHub refused merge');
  if (merged?.merged) {
    gh.commandResult = integratedMessage(gh, pr, merged.sha);
    if (metadata.tag) await tagPR(gh, await getPR(gh, number), metadata.tag);
  }
  return !!merged?.merged;
}
export async function tagPR(gh: GitHub, pr: PR, tag: string) {
  if (!pr.merged || !pr.merge_commit_sha) throw new Denied('只能给已合并 PR 创建 Tag');
  // Production version tags belong exclusively to the human-approved release flow.
  if (/^v\d/.test(tag) || !/^[a-zA-Z][\w.-]{0,79}$/.test(tag) || tag.endsWith('.lock') || tag.includes('..')) throw new Denied('普通 Tag 不得使用版本号，且必须是安全的单段名称');
  return gh.write(`tag:${tag}:${pr.merge_commit_sha}`, 'POST /repos/{owner}/{repo}/git/refs', { ref: `refs/tags/${tag}`, sha: pr.merge_commit_sha }, async () => {
    try {
      const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: `tags/${tag}` });
      if (ref.object.sha !== pr.merge_commit_sha) throw new Denied(`Tag ${tag} 已指向其他提交，拒绝覆盖。请使用其他普通 Tag 名称，或由维护者核对现有标签。`);
      return ref;
    } catch (e) { if (typeof e === 'object' && e && 'status' in e && e.status === 404) return undefined; throw e; }
  });
}
export async function welcome(gh: GitHub, number: number, user: { login: string; type: string }, kind: 'issue' | 'pr' | 'merged') {
  if (kind !== 'issue' || user.type === 'Bot' || !gh.config!.welcome.issue) return;
  const login = user.login.toLowerCase();
  const history = await gh.list('GET /repos/{owner}/{repo}/issues', { creator: user.login, state: 'all', sort: 'created', direction: 'asc' });
  const previous = history.filter(i => i.number !== number && !i.pull_request);
  if (previous.some(i => i.number < number)) return;
  const message = safeText(gh.config!.welcome[kind]);
  await gh.comment(number, `welcome:${kind}:${login}`, addressUser(user, `${message}\n\n[参与指南](${gh.config!.welcome.guide})`));
}
export const timelineFor = (gh: GitHub, number: number) => gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { issue_number: number });
interface ReviewPlan { selected: string[]; at: string }
function reviewerHistory(gh: GitHub, pr: PR, timeline: any[], reviews: Review[]) {
  const lastContact = new Map<string, number>();
  for (const event of timeline) if (['review_requested', 'review_request_removed'].includes(event.event) && event.requested_reviewer?.login) {
    const login = event.requested_reviewer.login.toLowerCase(), at = Date.parse(event.created_at);
    lastContact.set(login, Math.max(lastContact.get(login) ?? 0, Number.isFinite(at) ? at : Date.now()));
  }
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user.login.toLowerCase(), at = Date.parse(review.submitted_at);
    if (Number.isFinite(at)) lastContact.set(login, Math.max(lastContact.get(login) ?? 0, at));
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(login, review);
  }
  const excluded = new Set([pr.user.login, ...pr.requested_reviewers.map(r => r.login)].map(x => x.toLowerCase()));
  for (const [login, review] of latest) if (review.user.type === 'Bot' || review.state === 'CHANGES_REQUESTED' || review.state === 'APPROVED' && review.commit_id === pr.head.sha) excluded.add(login);
  for (const [login, at] of lastContact) if (Date.now() - at < gh.config!.reviewers.rotateHours * 3600000) excluded.add(login);
  return { excluded, lastContact };
}

export async function assign(gh: GitHub, pr: PR, specified?: string[], key = gh.job, policy?: ReturnType<typeof reviewPolicy>) {
  if (pr.draft || pr.state !== 'open') return [];
  const planKey = 'review-plan:' + key;
  let plan = await gh.getRecord<ReviewPlan>(pr.number, planKey);
  if (!plan) {
    const timeline = await timelineFor(gh, pr.number);
    const reviews = await reviewsFor(gh, pr.number);
    const { excluded: exclude, lastContact } = reviewerHistory(gh, pr, timeline, reviews);
    const candidates: string[] = [];
    for (const person of specified ?? policy?.pool ?? gh.config!.reviewers.pool) {
      if (person.toLowerCase() === pr.user.login.toLowerCase()) { if (specified) throw new Denied('不能请求作者审查自己的 PR。请邀请其他有仓库写权限的人工审查者。'); else continue; }
      if ((!specified && exclude.has(person.toLowerCase())) || !(await gh.maintainer(person))) continue;
      candidates.push(person);
    }
    const open = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', { state: 'open' });
    const load = (login: string) => open.reduce((n,p) => n + Number(p.requested_reviewers.some(r => r.login.toLowerCase() === login.toLowerCase())), 0);
    candidates.sort((a,b) => Number(lastContact.has(a.toLowerCase())) - Number(lastContact.has(b.toLowerCase())) || load(a) - load(b) || (lastContact.get(a.toLowerCase()) ?? 0) - (lastContact.get(b.toLowerCase()) ?? 0) || a.localeCompare(b));
    const selected = candidates.slice(0, specified ? specified.length : Math.max(0, (policy?.count ?? gh.config!.reviewers.count) - pr.requested_reviewers.length));
    if (!selected.length) return [];
    plan = await gh.record(pr.number, planKey, { selected, at: new Date().toISOString() }) ?? { selected, at: new Date().toISOString() };
  }
  for (const login of plan.selected) {
    if (!(await gh.maintainer(login)) || login.toLowerCase() === pr.user.login.toLowerCase()) throw new Denied('Review assignment plan no longer authorized');
  }
  // A successful historical request must not be sent again after the user responded/was removed.
  const events = await timelineFor(gh, pr.number);
  const already = plan.selected.every(login => events.some(e => e.event === 'review_requested' && e.requested_reviewer?.login.toLowerCase() === login.toLowerCase() && Date.parse(e.created_at) >= Date.parse(plan!.at) - 1000));
  if (already) return plan.selected;
  const result = await gh.write('reviewers:' + pr.number + ':' + key, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', { pull_number: pr.number, reviewers: plan.selected }, async () => {
    const current = await getPR(gh, pr.number);
    return plan!.selected.every(x => current.requested_reviewers.some(r => r.login.toLowerCase() === x.toLowerCase())) ? current : undefined;
  });
  return result ? plan.selected : [];
}
export async function removeReviewer(gh: GitHub, pr: PR, login: string, key: string) {
  return gh.write('remove-reviewer:' + pr.number + ':' + login + ':' + key, 'DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', { pull_number: pr.number, reviewers: [login] }, async () => {
    const current = await getPR(gh, pr.number);
    return current.requested_reviewers.some(x => x.login.toLowerCase() === login.toLowerCase()) ? undefined : current;
  });
}
export async function rotate(gh: GitHub, pr: PR, policy?: ReturnType<typeof reviewPolicy>) {
  if (pr.state !== 'open' || pr.draft) return;
  const timeline = await timelineFor(gh, pr.number), reviews = await reviewsFor(gh, pr.number);
  for (const reviewer of [...pr.requested_reviewers]) {
    const request = timeline.filter(e => e.event === 'review_requested' && e.requested_reviewer?.login.toLowerCase() === reviewer.login.toLowerCase()).sort((a,b) => b.id - a.id)[0];
    if (!request || !Number.isFinite(Date.parse(request.created_at))) continue;
    const requestedAt = Date.parse(request.created_at) / 1000;
    if (reviews.some(r => r.user.login.toLowerCase() === reviewer.login.toLowerCase() && Date.parse(r.submitted_at) / 1000 >= requestedAt)) continue;
    const age = epoch() - requestedAt;
    if (age >= gh.config!.reviewers.rotateHours * 3600) {
      const key = 'rotation:' + request.id;
      let transfer = await gh.getRecord<{ replacement: string }>(pr.number, key);
      if (!transfer) {
        const { excluded, lastContact } = reviewerHistory(gh, pr, timeline, reviews);
        const pool = [...(policy?.pool ?? gh.config!.reviewers.pool)].sort((a, b) => (lastContact.get(a.toLowerCase()) ?? 0) - (lastContact.get(b.toLowerCase()) ?? 0) || a.localeCompare(b));
        for (const person of pool) {
          if (excluded.has(person.toLowerCase()) || !(await gh.maintainer(person))) continue;
          transfer = await gh.record(pr.number, key, { replacement: person }) ?? { replacement: person }; break;
        }
      }
      if (!transfer) { await gh.comment(pr.number, 'pool-empty:' + request.id, addressUser({ login: reviewer.login, type: 'User' }, `审查等待超时，目前没有可用替补。请继续审查；如无法处理，请维护者在新评论中发送 \`/reviewers handoff ${reviewer.login} 新审查者用户名\`（替换最后一个参数，不带 @）安排交接。`)); continue; }
      const selected = await assign(gh, pr, [transfer.replacement], key);
      if (selected.length) await removeReviewer(gh, pr, reviewer.login, key);
    } else if (age >= gh.config!.reviewers.remindHours * 3600) {
      await gh.comment(pr.number, 'remind:' + request.id, addressUser({ login: reviewer.login, type: 'User' }, `审查请求已等待 ${gh.config!.reviewers.remindHours} 小时。请在 Files changed → Review changes 中提交 Approve（批准）或 Request changes（要求修改）。如无法处理，请维护者用 /reviewers handoff ${reviewer.login} 新审查者用户名 安排交接；发送 /help reviewers 查看用法。`));
    }
  }
}
async function finishPR(gh: GitHub, pr: PR, state: PRState) {
  if (pr.merged) {
    if (state.metadata.tag) await tagPR(gh, pr, state.metadata.tag);
  }
  await summarize(gh, pr, await prState(gh, pr));
}
export async function refreshPRStatus(gh: GitHub, number: number) {
  const pr = await getPR(gh, number), state = await prState(gh, pr);
  if (pr.state !== 'open') { await finishPR(gh, pr, state); return; }
  await summarize(gh, pr, state, await gate(gh, pr, gh.config!.release.enabled && pr.base.ref === gh.config!.release.target));
}
export async function notifyPR(gh: GitHub, number: number) {
  const pr = await getPR(gh, number), state = await prState(gh, pr);
  const releasePR = gh.config!.release.enabled && pr.base.ref === gh.config!.release.target;
  await integrationNotice(gh, pr, state, pr.state === 'open' ? await gate(gh, pr, releasePR) : undefined);
}
async function renderPR(gh: GitHub, pr: PR, state: PRState, result?: Gate, files?: Awaited<ReturnType<typeof filesFor>>) {
  const more = await syncLabels(gh, pr, state, files ?? await filesFor(gh, pr.number), result);
  const current = await getPR(gh, pr.number);
  if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha || current.base.ref !== pr.base.ref || current.state !== pr.state) throw new Retryable('PR changed during status refresh');
  await summarize(gh, current, state, result);
  await integrationNotice(gh, current, state, result);
  return more;
}
export async function refreshPR(gh: GitHub, number: number) {
  const pr = await getPR(gh, number), state = await prState(gh, pr), files = await filesFor(gh, number);
  if (pr.merged && state.metadata.tag) await tagPR(gh, pr, state.metadata.tag);
  const result = pr.state === 'open' ? await gate(gh, pr, gh.config!.release.enabled && pr.base.ref === gh.config!.release.target, files) : undefined;
  return renderPR(gh, pr, state, result, files);
}
export async function reconcilePR(gh: GitHub, number: number, renderAll = false): Promise<boolean> {
  let pr = await getPR(gh, number);
  await gh.ensureStatus(number);
  if (pr.state !== 'open') {
    if (renderAll) return refreshPR(gh, number);
    await finishPR(gh, pr, await prState(gh, pr)); return false;
  }
  const filesHead = pr.head.sha, filesBase = pr.base.sha;
  const files = await filesFor(gh, number);
  const policy = reviewPolicy(gh.config!, pr, files);
  await rotate(gh, pr, policy);
  await assign(gh, pr, undefined, gh.job, policy);
  pr = await getPR(gh, number);
  const state = await prState(gh, pr);
  if (pr.state !== 'open') {
    if (renderAll) return refreshPR(gh, number);
    await finishPR(gh, pr, state); return false;
  }
  const releasePR = gh.config!.release.enabled && pr.base.ref === gh.config!.release.target;
  const result = await gate(gh, pr, releasePR, pr.head.sha === filesHead && pr.base.sha === filesBase ? files : undefined);
  if (renderAll) {
    if (!releasePR && result.ready) {
      if (result.autoRequestValid && state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha && state.integrate_actor) {
        await integrate(gh, number, state.integrate_actor, pr.head.sha, true);
        return refreshPR(gh, number);
      }
      if (gh.config!.merge.auto && !result.highRisk && await gh.maintainer(pr.user.login)) {
        await integrate(gh, number, pr.user.login, pr.head.sha, true, true);
        return refreshPR(gh, number);
      }
    }
    return renderPR(gh, pr, state, result, pr.head.sha === filesHead && pr.base.sha === filesBase ? files : undefined);
  }
  await summarize(gh, pr, state, result);
  if (releasePR) return false;
  if (result.autoRequestValid && state.integrate_mode === 'auto' && state.integrate_head === pr.head.sha && state.integrate_actor) return integrate(gh, number, state.integrate_actor, pr.head.sha, true);
  if (gh.config!.merge.auto && result.ready && !result.highRisk && await gh.maintainer(pr.user.login)) return integrate(gh, number, pr.user.login, pr.head.sha, true, true);
  return false;
}

export async function refreshLabels(gh: GitHub, number: number) {
  const pr = await getPR(gh, number), state = await prState(gh, pr), files = await filesFor(gh, number);
  const result = pr.state === 'open' ? await gate(gh, pr, gh.config!.release.enabled && pr.base.ref === gh.config!.release.target, files) : undefined;
  return syncLabels(gh, pr, state, files, result);
}
