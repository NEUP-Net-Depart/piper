import { integratedMessage } from './commits';
import { allowed } from './config';
import type { GitHub } from './github';
import { getPR } from './pulls';
import { notesFor } from './release-notes';
import {
  RELEASE_DELAY_MS,
  RELEASE_LABEL,
  RELEASE_RECORD,
  releaseBranches,
  releaseCancelled,
  releaseGate,
  releaseMaintainer,
  releasePlan,
  signReleasePlan,
  type ReleasePlan,
} from './release-policy';
import { Denied, Retryable, safeText, sha256, type PR } from './types';

export interface ReleaseRow {
  repo: string;
  cycle: string;
  version: string;
  pr_number: number | null;
  source_sha: string;
  merge_sha: string | null;
  mergeAfter: string;
  state: string;
  notes: string;
  error: string | null;
}
export function localTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!),
  };
}
export function releaseTitle(date: Date) {
  const [year, month, day] = localTime(date, 'Asia/Shanghai').date.split('-');
  return `[release] ${year}年${Number(month)}月${Number(day)}日版本发布`;
}
export function releaseStatusMessage(gh: GitHub, row: ReleaseRow) {
  const status: Record<string, string> = {
    waiting: '等待自动合并。',
    merged: '已合并。',
    cancelled: '已取消。',
  };
  return [
    `**${safeText(row.version)}** · [PR #${row.pr_number}](https://github.com/${gh.repo}/pull/${row.pr_number})`,
    status[row.state] ?? row.state,
    ...(row.state === 'waiting'
      ? [
          `最早合并时间：${new Date(row.mergeAfter).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。`,
        ]
      : []),
  ].join('\n\n');
}
function ensureRelease(gh: GitHub) {
  if (!allowed(gh.env, gh.repo) || !gh.config!.release.enabled)
    throw new Denied('该仓库未启用发布，请维护者检查仓库白名单和 release.enabled 配置');
}
export async function releaseFor(gh: GitHub, pr: PR): Promise<ReleaseRow | null> {
  const plan = await releasePlan(gh, pr);
  if (!plan) return null;
  return {
    repo: gh.repo,
    cycle: plan.request,
    version: plan.title,
    pr_number: pr.number,
    source_sha: pr.head.sha,
    merge_sha: pr.merge_commit_sha,
    mergeAfter: plan.mergeAfter,
    notes: '',
    error: null,
    state: pr.merged ? 'merged' : (await releaseCancelled(gh, pr)) ? 'cancelled' : 'waiting',
  };
}
export async function listReleases(gh: GitHub, openOnly = false): Promise<ReleaseRow[]> {
  const prs = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', {
    state: openOnly ? 'open' : 'all',
    head: gh.owner + ':dev',
    base: 'main',
    sort: 'created',
    direction: 'desc',
  });
  const rows: ReleaseRow[] = [];
  for (const pr of prs) {
    const row = await releaseFor(gh, await getPR(gh, pr.number));
    if (row) rows.push(row);
  }
  return rows;
}
async function updateRelease(gh: GitHub, pr: PR, plan: ReleasePlan) {
  const progress = pr.body?.indexOf('\n\n<!-- piper:progress -->') ?? -1;
  const prefix = progress >= 0 ? pr.body!.slice(0, progress) : (pr.body ?? '');
  const key = 'release-notes:v3:' + pr.base.sha + ':' + pr.head.sha;
  const cached = await gh.getRecord<{ digest: string }>(pr.number, key);
  if (cached?.digest === (await sha256(prefix)) && pr.title === plan.title) return;
  const notes = await notesFor(gh, pr.base.sha, pr.head.sha);
  const body = `<!-- piper-release:v2 -->\n${notes}\n\n最早合并时间：${new Date(plan.mergeAfter).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。\n关闭 PR 或移除 \`${RELEASE_LABEL}\` 可取消。`;
  const fullBody = body + (progress >= 0 ? pr.body!.slice(progress) : '');
  if (pr.body === fullBody && pr.title === plan.title) {
    await gh.record(pr.number, key, { digest: await sha256(body) });
    return;
  }
  await gh.write(
    'release-notes:' + pr.number,
    'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
    { pull_number: pr.number, title: plan.title, body: fullBody },
    async () => {
      const current = await getPR(gh, pr.number);
      if (
        current.state !== 'open' ||
        current.head.sha !== pr.head.sha ||
        current.base.sha !== pr.base.sha ||
        !releaseBranches(gh, current)
      )
        throw new Retryable('发布 PR 在更新说明时发生变化');
      if (current.body === fullBody && current.title === plan.title) return current;
      if (current.body !== pr.body) throw new Retryable('发布说明已变化');
      return undefined;
    },
  );
  await gh.record(pr.number, key, { digest: await sha256(body) });
}
// Only explicit, authenticated commands/dispatches call this with force=true.
// Cron is reconciliation only and must never create a release.
export async function prepareRelease(gh: GitHub, _date: Date, force = false): Promise<ReleaseRow | null> {
  ensureRelease(gh);
  if (!force) return null;
  if (!(await releaseMaintainer(gh, gh.actor))) throw new Denied('发布入口需要 maintain / admin 维护者权限');
  const requestMarker = `<!-- piper-release-request:${await sha256(gh.job)} -->`;
  const prs = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', {
    state: 'all',
    head: gh.owner + ':dev',
    base: 'main',
    sort: 'created',
    direction: 'desc',
  });
  // Persist request IDs on the PR, including reused PRs. Replaying an old request
  // after merge/close must not create a new release with newer dev commits.
  for (const item of prs) {
    if (
      item.state === 'closed' &&
      item.user.login === gh.env.BOT_LOGIN &&
      item.user.type === 'Bot' &&
      item.body?.includes(requestMarker)
    )
      return releaseFor(gh, await getPR(gh, item.number));
    if (await gh.getRecord(item.number, 'release-request:' + gh.job)) {
      const current = await getPR(gh, item.number);
      const plan = await releasePlan(gh, current);
      if (plan && current.state === 'open') await updateRelease(gh, current, plan);
      return releaseFor(gh, current);
    }
    const plan = await releasePlan(gh, item);
    if (plan?.request === gh.job && item.state !== 'open') return releaseFor(gh, await getPR(gh, item.number));
  }
  let pr = prs.find((p) => p.state === 'open');
  if (pr && (pr.user.login !== gh.env.BOT_LOGIN || pr.user.type !== 'Bot' || pr.draft))
    throw new Denied('已有非 Piper 正式发布 PR，拒绝重复创建或自动接管');
  if (!pr) {
    const source = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/dev' });
    const target = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/main' });
    const comparison = await gh.compare(target.object.sha, source.object.sha);
    if (comparison.ahead_by === 0) return null;
    if (!['ahead', 'diverged'].includes(comparison.status)) throw new Denied('main...dev 没有可发布比较结果');
    pr =
      (await gh.write(
        'release-create:' + gh.job,
        'POST /repos/{owner}/{repo}/pulls',
        {
          title: releaseTitle(new Date()),
          head: 'dev',
          base: 'main',
          draft: false,
          body: '<!-- piper-release:v2 -->\n' + requestMarker + '\n正在整理发布说明。',
        },
        async () => {
          const open = await gh.list<PR>(
            'GET /repos/{owner}/{repo}/pulls',
            { state: 'open', head: gh.owner + ':dev', base: 'main' },
            undefined,
            true,
          );
          if (open.length) throw new Retryable('已有 dev → main PR，重新核验后复用');
          return undefined;
        },
      )) ?? undefined;
    if (!pr) return null;
  }
  pr = await getPR(gh, pr.number);
  let plan = await releasePlan(gh, pr);
  if (!plan) {
    if (!pr.created_at || !Number.isFinite(Date.parse(pr.created_at))) throw new Denied('GitHub 缺少 PR 创建时间');
    plan = {
      createdAt: pr.created_at,
      mergeAfter: new Date(Date.parse(pr.created_at) + RELEASE_DELAY_MS).toISOString(),
      title: releaseTitle(new Date(pr.created_at)),
      request: gh.job,
      signature: '',
    };
    plan.signature = await signReleasePlan(gh, pr.number, plan);
    // Save before labeling. A lost label write is recovered only for this initial
    // request; a historical removal/close is permanently recorded as cancellation.
    await gh.record(pr.number, RELEASE_RECORD, plan);
  }
  if (!(await gh.getRecord(pr.number, 'release-armed:v2'))) {
    const history = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      issue_number: pr.number,
    });
    if (history.some((e) => e.event === 'closed' || (e.event === 'unlabeled' && e.label?.name === RELEASE_LABEL)))
      await gh.record(pr.number, 'release-cancelled:v2', { at: new Date().toISOString() });
    else await gh.setLabels(pr.number, ['release', RELEASE_LABEL], 'release-label:' + pr.number);
    await gh.record(pr.number, 'release-armed:v2', { at: new Date().toISOString() });
  }
  await gh.record(pr.number, 'release-request:' + gh.job, { actor: gh.actor });
  await updateRelease(gh, await getPR(gh, pr.number), plan);
  return releaseFor(gh, await getPR(gh, pr.number));
}
export async function requestRelease(gh: GitHub, runId: number) {
  ensureRelease(gh);
  const run = await gh.read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: runId });
  const repo = await gh.read('GET /repos/{owner}/{repo}');
  if (run.status !== 'completed' || run.conclusion !== 'success')
    throw new Retryable('发布入口正在重跑或未成功，等待成功结果');
  if (
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/' + gh.config!.release.requestWorkflow ||
    run.head_branch !== repo.default_branch ||
    run.head_repository?.full_name.toLowerCase() !== gh.repo.toLowerCase() ||
    run.repository?.full_name.toLowerCase() !== gh.repo.toLowerCase() ||
    run.actor?.type !== 'User' ||
    run.triggering_actor?.type !== 'User' ||
    !(await releaseMaintainer(gh, run.actor.login)) ||
    !(await releaseMaintainer(gh, run.triggering_actor.login))
  )
    throw new Denied('发布请求必须来自默认分支的维护者 workflow_dispatch');
  gh.actor = run.triggering_actor.login;
  return prepareRelease(gh, new Date(run.created_at), true);
}
async function mergeRelease(gh: GitHub, number: number, manual = false) {
  ensureRelease(gh);
  const pr = await getPR(gh, number);
  const plan = await releasePlan(gh, pr);
  if (!plan) throw new Denied('这不是 Piper 登记的发布 PR');
  if (pr.merged) {
    gh.commandResult = '已合并。';
    return;
  }
  const gate = await releaseGate(gh, pr, !manual);
  if (!gate.ready) {
    if (manual) throw new Denied('发布尚未满足条件：' + gate.reasons.join('；'));
    return;
  }
  if (manual)
    await gh.record(pr.number, 'release-approval:' + pr.head.sha, { head: pr.head.sha, actor: gh.actor, job: gh.job });
  const merged = await gh.write(
    'release-merge:' + number + ':' + pr.head.sha,
    'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
    {
      pull_number: number,
      merge_method: 'merge',
      sha: pr.head.sha,
      commit_title: plan.title,
      commit_message: '',
    },
    async () => {
      const current = await getPR(gh, number);
      if (current.merged) return { merged: true, sha: current.merge_commit_sha };
      if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha || !releaseBranches(gh, current))
        throw new Retryable('Release HEAD 或 Base 已更新，重新核验后再合并');
      // Repeat uncached verification immediately before the write, including cancellation.
      const latest = await releaseGate(gh, current, !manual);
      if (!latest.ready) throw new Retryable(latest.reasons.join('；'));
      return undefined;
    },
  );
  if (merged && !merged.merged) throw new Retryable('GitHub 暂未允许发布合并，将自动重试');
  if (merged?.merged) gh.commandResult = integratedMessage(gh, pr, merged.sha);
}
export async function publishRelease(gh: GitHub, number: number, actor: string) {
  ensureRelease(gh);
  if (!(await releaseMaintainer(gh, actor))) throw new Denied('提前发布需要 maintain / admin 维护者权限');
  gh.actor = actor;
  return gh.fresh(() => mergeRelease(gh, number, true));
}
export async function syncRelease(gh: GitHub, row: ReleaseRow) {
  ensureRelease(gh);
  return gh.fresh(async () => {
    if (!row.pr_number) return;
    const pr = await getPR(gh, row.pr_number);
    const plan = await releasePlan(gh, pr);
    if (!plan || pr.state !== 'open') return;
    await updateRelease(gh, pr, plan);
    if (!(await gh.getRecord(pr.number, 'release-armed:v2'))) return; // preparation retry owns arming
    await mergeRelease(gh, pr.number);
  });
}
