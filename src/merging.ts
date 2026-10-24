import { z } from 'zod';
import type { GitHub } from './github';
import type { NativeRecord } from './records';
import { integratedMessage } from './commits';
import { Denied, safeText, statusCode, type PR } from './types';

const options = z.object({
  sha: z.string().min(1), merge_method: z.literal('squash'), merge_action: z.literal('direct_merge'),
  bypass_rules: z.literal(false), commit_title: z.string(), commit_message: z.string()
});
export const mergeIntentSchema = z.object({
  key: z.string().min(1).max(270), at: z.number().finite().nonnegative(), actor: z.string().min(1),
  replyJob: z.string().nullable(), target: z.string().min(1), snapshot: z.string(), options
});
export type MergeIntent = z.infer<typeof mergeIntentSchema>;
const acceptedSchema = z.object({ uuid: z.uuid() });
const mergedSchema = z.object({ status: z.literal('merged'), message: z.string(), sha: z.string().min(1) });
const resultSchema = z.discriminatedUnion('status', [
  mergedSchema,
  z.object({ status: z.enum(['failed', 'unknown', 'enqueued']), message: z.string() })
]);
export interface MergeState {
  intent: MergeIntent;
  accepted?: z.infer<typeof acceptedSchema>;
  result?: z.infer<typeof resultSchema>;
}
const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), details: z.object({
    message: z.string(), uuid: z.uuid(), expected_head_sha: z.string().min(1),
    merge_method: z.enum(['default', 'merge', 'squash', 'rebase']), merge_action: z.enum(['default', 'direct_merge', 'merge_queue']),
    bypass_rules: z.boolean().optional(), commit_title: z.string().optional(), commit_message: z.string().optional()
  }) }),
  z.object({ status: z.literal('merged'), details: z.object({ message: z.string(), sha: z.string().min(1) }) }),
  z.object({ status: z.enum(['failed', 'enqueued']), details: z.object({ message: z.string() }) })
]);
export type AsyncMergeResponse = z.infer<typeof responseSchema>;
export const MERGE_RETENTION_MS = 24 * 3600000;
const route = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async';

export function mergeState(records: NativeRecord[]): MergeState | undefined {
  const last = records.filter(r => r.key.startsWith('merge-intent:')).at(-1);
  if (!last) return;
  const intent = mergeIntentSchema.parse(last.value);
  if (last.key !== 'merge-intent:' + intent.key) throw new Denied('Invalid merge intent record');
  const accepted = records.find(r => r.key === 'merge-accepted:' + intent.key);
  const result = records.find(r => r.key === 'merge-result:' + intent.key);
  const confirmed = records.find(r => r.key === 'merge-confirmed:' + intent.key);
  return { intent, accepted: accepted && acceptedSchema.parse(accepted.value), result: confirmed ? mergedSchema.parse(confirmed.value) : result && resultSchema.parse(result.value) };
}
export function mergeFeedback(state: MergeState) {
  if (state.result?.status === 'failed') return `合并失败：${safeText(state.result.message)}\n\n修复原因后，请在新评论中重新发送 /integrate。`;
  if (state.result?.status === 'unknown') return `结果暂时无法确认：${safeText(state.result.message)}\n\n请维护者在 GitHub 核实并人工处理本次合并。Piper 不会重新提交请求。`;
  if (state.result?.status === 'enqueued') return 'GitHub 返回已进入 Merge Queue，尚未合并。Piper 暂不管理 Merge Queue；请维护者在 GitHub 查看队列结果，不要重复提交。';
  if (state.result?.status === 'merged') return '合并成功。';
  return state.accepted ? 'GitHub 已受理合并请求，正在异步合并。无需重复发送命令。' : '结果暂时无法确认：提交请求时响应丢失或处理被中断。Piper 正在核实 PR 实际状态，不会重复提交。';
}
const getPR = (gh: GitHub, number: number) => gh.read<PR>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number });
async function feedback(gh: GitHub, number: number, state: MergeState, pr?: PR) {
  const message = state.result?.status === 'merged' && pr ? integratedMessage(gh, pr, state.result.sha) : mergeFeedback(state);
  gh.commandResult = message;
  if (state.intent.replyJob) await gh.replyFor(number, state.intent.replyJob, message, state.intent.actor);
  else await gh.managedComment(number, '<!-- piper:ready -->', message);
}
async function finish(gh: GitHub, number: number, state: MergeState, result: NonNullable<MergeState['result']>, pr?: PR) {
  // A verified success can supersede an earlier inconclusive result without rewriting receipts.
  state.result = await gh.record(number, (result.status === 'merged' ? 'merge-confirmed:' : 'merge-result:') + state.intent.key, result) ?? result;
  gh.mergePolls.delete(number);
  await feedback(gh, number, state, pr);
  return state.result.status === 'merged';
}
function matches(response: Extract<AsyncMergeResponse, { status: 'pending' }>, state: MergeState, conflict: boolean) {
  const d = response.details, o = state.intent.options;
  return (!state.accepted || state.accepted.uuid === d.uuid) && d.expected_head_sha === o.sha &&
    d.merge_method === o.merge_method && d.merge_action === o.merge_action &&
    (d.bypass_rules === false || !conflict && d.bypass_rules === undefined) &&
    (d.commit_title === undefined || d.commit_title === o.commit_title) && (d.commit_message === undefined || d.commit_message === o.commit_message);
}
async function observedMerge(gh: GitHub, number: number, state: MergeState, pr: PR, sha = pr.merge_commit_sha) {
  if (!pr.merged) return;
  if (pr.head.sha !== state.intent.options.sha || pr.base.ref !== state.intent.target || sha && pr.merge_commit_sha && sha !== pr.merge_commit_sha) {
    await finish(gh, number, state, { status: 'unknown', message: 'PR 已合并，但最终 HEAD、目标分支或提交无法与本次请求对应。' });
    return 'unknown' as const;
  }
  if (!sha) return; // Missing evidence is not a conflicting HEAD or target.
  await finish(gh, number, state, { status: 'merged', sha, message: '已核实合并结果。' }, pr);
  return 'merged' as const;
}
async function acceptResponse(gh: GitHub, number: number, state: MergeState, raw: unknown, conflict = false, failures = 0) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return finish(gh, number, state, { status: 'unknown', message: 'GitHub 合并响应格式无法核实。' });
  const response = parsed.data;
  if (response.status === 'pending') {
    if (!matches(response, state, conflict)) return finish(gh, number, state, { status: 'unknown', message: '已有异步请求的 UUID、HEAD 或合并选项与本次请求不一致。' });
    state.accepted = await gh.record(number, 'merge-accepted:' + state.intent.key, { uuid: response.details.uuid }) ?? { uuid: response.details.uuid };
    if (!state.result) gh.mergePolls.set(number, 0);
    await feedback(gh, number, state);
    return false;
  }
  if (conflict) return finish(gh, number, state, { status: 'unknown', message: 'GitHub 返回已有请求，但缺少可核实的待处理请求信息。' });
  if (response.status !== 'merged') return finish(gh, number, state, { status: response.status, message: response.details.message });
  let pr: PR;
  try { pr = await getPR(gh, number); }
  catch (e) { return pollFailure(gh, number, state, e, failures); }
  const observed = await observedMerge(gh, number, state, pr, response.details.sha);
  if (observed) return observed === 'merged';
  if (!state.result) gh.mergePolls.set(number, 0);
  await feedback(gh, number, state);
  return false;
}
function errorData(error: unknown): { data?: unknown; headers?: Record<string, string> } {
  return typeof error === 'object' && error && 'response' in error ? (error.response ?? {}) as ReturnType<typeof errorData> : {};
}
function errorMessage(error: unknown) {
  const body = z.object({ message: z.string().optional(), details: z.object({ message: z.string() }).optional() }).safeParse(errorData(error).data);
  return (body.success && (body.data.details?.message ?? body.data.message) || (error instanceof Error ? error.message : 'GitHub 暂时不可用')).slice(0, 1000);
}
function permanent(error: unknown) {
  return [400, 403, 404, 422].includes(statusCode(error)) && !rateLimited(error);
}
function rateLimited(error: unknown) {
  const status = statusCode(error), headers = errorData(error).headers;
  return status === 429 || status === 403 && (!!headers?.['retry-after'] || headers?.['x-ratelimit-remaining'] === '0' || error instanceof Error && /rate limit/i.test(error.message));
}
export async function submitMerge(gh: GitHub, number: number, intent: MergeIntent, verify: () => Promise<void>) {
  if (gh.dryRun) {
    await gh.write('integrate:' + intent.key, route, { pull_number: number, ...intent.options }, async () => undefined);
    return false;
  }
  const state: MergeState = { intent };
  // Persist before the side effect. A crash between these steps is ambiguous, never permission to resend.
  await gh.record(number, 'merge-intent:' + intent.key, intent);
  let response: { status?: number; data: unknown } | null;
  try {
    response = await gh.write('integrate:' + intent.key, route, { pull_number: number, ...intent.options }, async () => {
      await verify();
      return undefined;
    }, (data, status) => ({ data, status }));
  } catch (e) {
    if (statusCode(e) === 409) return acceptResponse(gh, number, state, errorData(e).data, true);
    if (rateLimited(e)) return finish(gh, number, state, { status: 'failed', message: 'GitHub 暂时限流，尚未受理合并请求。请稍后重新发送 /integrate。' });
    if (e instanceof Denied || permanent(e)) return finish(gh, number, state, { status: 'failed', message: errorMessage(e) });
    gh.audit('merge', 'unconfirmed', { message: e instanceof Error ? e.message : 'Network failure' });
    gh.mergePolls.set(number, 0);
    await feedback(gh, number, state);
    return false;
  }
  const body = responseSchema.safeParse(response?.data);
  if (!body.success || response?.status !== 202 && response?.status !== 200 ||
    response.status === 202 && body.data.status !== 'pending' || response.status === 200 && !['merged', 'enqueued'].includes(body.data.status)) {
    return finish(gh, number, state, { status: 'unknown', message: 'GitHub 合并响应的 HTTP 状态或正文无法核实。' });
  }
  return acceptResponse(gh, number, state, body.data);
}

async function pollFailure(gh: GitHub, number: number, state: MergeState, e: unknown, failures: number) {
  gh.audit('merge-poll', 'unconfirmed', { message: e instanceof Error ? e.message : 'Network failure' });
  if (state.result) { await feedback(gh, number, state); return false; }
  if (permanent(e) || failures >= 4) return finish(gh, number, state, { status: 'unknown', message: `查询合并结果失败：${errorMessage(e)}` });
  gh.mergePolls.set(number, failures + 1);
  await feedback(gh, number, state);
  return false;
}
export async function trackMerge(gh: GitHub, number: number, failures = 0): Promise<boolean> {
  const state = mergeState(await gh.records(number));
  if (!state) return false;
  if (state.result && state.result.status !== 'unknown') {
    if (state.result.status !== 'merged') await feedback(gh, number, state);
    return false;
  }
  let pr: PR;
  try { pr = await getPR(gh, number); }
  catch (e) { return pollFailure(gh, number, state, e, failures); }
  // Terminal uncertainty may be corrected by a later verified outcome, never by resubmission.
  if (state.result && (!state.accepted || !pr.merged)) { await feedback(gh, number, state); return false; }
  if (state.accepted && Date.now() - state.intent.at < MERGE_RETENTION_MS) {
    let response: unknown;
    try { response = await gh.read<unknown>('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', { pull_number: number, uuid: state.accepted.uuid }); }
    catch (e) {
      const observed = await observedMerge(gh, number, state, pr);
      if (observed) return observed === 'merged';
      return pollFailure(gh, number, state, e, failures);
    }
    return acceptResponse(gh, number, state, response, false, failures);
  }
  const observed = await observedMerge(gh, number, state, pr);
  if (observed) return observed === 'merged';
  if (Date.now() - state.intent.at >= MERGE_RETENTION_MS) return finish(gh, number, state, { status: 'unknown', message: '请求已超过 24 小时保留期，PR 尚未确认合并。' });
  if (pr.state !== 'open' && !pr.merged) return finish(gh, number, state, { status: 'failed', message: 'PR 已关闭且未合并。' });
  gh.mergePolls.set(number, 0);
  await feedback(gh, number, state);
  return false;
}
