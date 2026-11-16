import type { GitHub } from './github';
import { Denied, type Gate, type PR } from './types';

export const RELEASE_LABEL = 'auto-release';
export const RELEASE_RECORD = 'release:v2';
export const RELEASE_DELAY_MS = 2 * 60 * 60 * 1000;
export interface ReleasePlan {
  createdAt: string;
  mergeAfter: string;
  title: string;
  request: string;
  signature: string;
}
// GitHub permits privileged users to edit Bot comments. Bind the creation
// authorization to its repository/PR with a secret unavailable to PR writers.
export async function signReleasePlan(gh: GitHub, number: number, plan: Omit<ReleasePlan, 'signature'>) {
  if (!gh.env.WEBHOOK_SECRET) throw new Denied('发布回执签名密钥未配置');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(gh.env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = JSON.stringify([
    'piper-release:v2',
    gh.repo.toLowerCase(),
    number,
    plan.createdAt,
    plan.mergeAfter,
    plan.title,
    plan.request,
  ]);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function releaseBranches(gh: GitHub, pr: PR) {
  return (
    pr.head.ref === 'dev' &&
    pr.base.ref === 'main' &&
    pr.head.repo?.full_name.toLowerCase() === gh.repo.toLowerCase() &&
    pr.base.repo.full_name.toLowerCase() === gh.repo.toLowerCase()
  );
}
export async function releasePlan(gh: GitHub, pr: PR): Promise<ReleasePlan | undefined> {
  if (!releaseBranches(gh, pr) || pr.user.login !== gh.env.BOT_LOGIN || pr.user.type !== 'Bot') return;
  const plan = await gh.getRecord<ReleasePlan>(pr.number, RELEASE_RECORD);
  if (!plan) return;
  if (
    plan.createdAt !== pr.created_at ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    Date.parse(plan.mergeAfter) !== Date.parse(plan.createdAt) + RELEASE_DELAY_MS ||
    !/^\[release\] \d{4}年\d{1,2}月\d{1,2}日版本发布$/.test(plan.title) ||
    !plan.request
  )
    throw new Denied('发布回执无效，需维护者核对');
  if (typeof plan.signature !== 'string' || plan.signature !== (await signReleasePlan(gh, pr.number, plan))) {
    if (pr.state === 'closed') return; // Closed history cannot authorize a merge after secret rotation.
    throw new Denied('发布回执签名无效，拒绝自动发布');
  }
  return plan;
}
export async function releaseMaintainer(gh: GitHub, login: string) {
  const permission = await gh.read('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
    username: login,
  });
  return ['maintain', 'admin'].includes(permission.role_name ?? permission.permission);
}
export async function releaseCancelled(gh: GitHub, pr: PR) {
  if (await gh.getRecord(pr.number, 'release-cancelled:v2')) return true;
  const history = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
    issue_number: pr.number,
  });
  const armed = await gh.getRecord(pr.number, 'release-armed:v2');
  const cancelled =
    (!pr.merged && pr.state !== 'open') ||
    (!!armed && !pr.labels.some((l) => l.name === RELEASE_LABEL)) ||
    history.some((e) => e.event === 'closed' || (e.event === 'unlabeled' && e.label?.name === RELEASE_LABEL));
  if (cancelled && !pr.merged) await gh.record(pr.number, 'release-cancelled:v2', { at: new Date().toISOString() });
  return cancelled;
}

// Read jobs from one specific dev push run and its latest attempt. PR checks may
// deliberately be skipped and must never replace this deployment evidence.
export async function devVerification(gh: GitHub, sha: string): Promise<string[]> {
  const cfg = gh.config!.release;
  const runs = await gh.list(
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
    {
      workflow_id: cfg.deploymentWorkflow,
      head_sha: sha,
      branch: 'dev',
      event: 'push',
    },
    'workflow_runs',
  );
  const run = runs
    .filter(
      (r) =>
        r.head_sha === sha &&
        r.head_branch === 'dev' &&
        r.event === 'push' &&
        r.path === '.github/workflows/' + cfg.deploymentWorkflow &&
        r.repository?.full_name.toLowerCase() === gh.repo.toLowerCase(),
    )
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!run || run.status !== 'completed') return ['等待最新 dev 检查'];
  if (run.conclusion !== 'success') return ['最新 dev 检查未通过，请修复或重跑'];
  const jobs = await gh.list(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    {
      run_id: run.id,
      attempt_number: run.run_attempt,
    },
    'jobs',
  );
  for (const name of new Set([...cfg.requiredChecks, cfg.deploymentJob])) {
    const matches = jobs.filter((j) => j.name === name);
    const job = matches[0];
    if (matches.length !== 1 || job.head_sha !== sha || job.status !== 'completed' || job.conclusion !== 'success')
      return [`dev 的 ${name} 未通过或缺失`];
    const id = /^https:\/\/api.github.com\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(job.check_run_url ?? '')?.[1];
    if (!id) return [`${name} 缺少可信 Check Run`];
    const check = await gh.read('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', { check_run_id: Number(id) });
    if (
      !gh.config!.merge.trustedCheckAppIds.includes(check.app?.id) ||
      check.head_sha !== sha ||
      check.check_suite?.id !== run.check_suite_id ||
      check.status !== 'completed' ||
      check.conclusion !== 'success'
    )
      return [`${name} 的检查来源、提交或工作流不匹配`];
  }
  return [];
}
export async function releaseGate(gh: GitHub, pr: PR, waitForDeadline = true): Promise<Gate> {
  const plan = await releasePlan(gh, pr);
  const reasons: string[] = [];
  if (!gh.config!.release.enabled || !plan) reasons.push('请使用 Piper 创建并登记的 dev → main 发布 PR');
  if (pr.state !== 'open' || pr.merged || pr.draft) reasons.push('发布 PR 必须处于正式、未关闭状态');
  if (plan && !(await gh.getRecord(pr.number, 'release-armed:v2'))) reasons.push('正在登记发布');
  if (plan && (await releaseCancelled(gh, pr))) reasons.push('自动发布已取消');
  if (plan && waitForDeadline && Date.now() < Date.parse(plan.mergeAfter)) reasons.push('等待合并时间');
  if (pr.mergeable !== true || ['dirty', 'behind', 'unknown', 'draft'].includes(pr.mergeable_state))
    reasons.push('存在合并冲突或 GitHub 尚未完成合并检查');
  if (plan) {
    const source = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/dev' });
    if (source.object.sha !== pr.head.sha) reasons.push('dev 已更新，等待 PR 同步');
    else reasons.push(...(await devVerification(gh, pr.head.sha)));
  }
  return {
    ready: !reasons.length,
    reasons,
    reviewers: [],
    highRisk: false,
    progress: [
      { name: '人工审查', ready: !!plan, detail: plan ? '无需审批' : '缺少发布回执' },
      {
        name: '自动发布',
        ready: !reasons.length,
        detail: reasons.join('；') || '等待合并',
        owner: '等待',
      },
    ],
  };
}
