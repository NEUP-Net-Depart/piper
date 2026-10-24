import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github';
import { gate, integrate, reconcilePR, refreshPR } from '../src/pulls';
import { MERGE_RETENTION_MS, trackMerge } from '../src/merging';
import { decodeRecords, prState, visibleComment } from '../src/records';
import { processJob } from '../src/worker';
import { sha256, type Job } from '../src/types';
import { fixture, repo } from './fixtures';

const submit = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async';
const poll = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}';
const readPR = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const readStack = 'GET /repos/{owner}/{repo}/stacks';
const queued = (env: Awaited<ReturnType<typeof fixture>>['env']): Job[] => (env.TASKS.send as any).mock.calls.map((c: any[]) => c[0] as Job);
const error = (status: number, message: string, data: unknown = { message }, headers = {}) => Object.assign(new Error(message), { status, response: { data, headers } });
afterEach(() => vi.restoreAllMocks());

async function request() {
  const f = await fixture();
  f.api.mergeImmediately = false;
  const body = '/integrate';
  f.api.comments.push({ id: 99, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
  const job: Job = { id: 'command:' + repo.toLowerCase() + ':99', repo, installation: 1, kind: 'command', number: 1, actor: 'alice', commentId: 99, bodyHash: await sha256(body), time: new Date().toISOString() };
  const run = () => processJob(f.env, job, f.api);
  const next = () => processJob(f.env, queued(f.env).filter(j => j.kind === 'merge-poll').at(-1)!, f.api);
  return { ...f, job, run, next };
}
async function stackFixture(position = 1) {
  const f = await fixture();
  f.api.pr.number = position === 1 ? 72 : 74;
  f.api.pr.head.ref = position === 1 ? 'feat/bottom' : 'feat/top';
  f.api.pr.base.ref = position === 1 ? 'dev' : 'feat/bottom';
  f.api.pr.stack = { id: 10, number: 75, base: { ref: 'dev', sha: 'base123' }, size: 2, position };
  f.api.stacks = [{ id: 10, number: 75, base: { ref: 'dev' }, pull_requests: [
    { number: 72, state: 'open', merged_at: null, head: { ref: 'feat/bottom', sha: position === 1 ? 'abc123' : 'bottom123' } },
    { number: 74, state: 'open', merged_at: null, head: { ref: 'feat/top', sha: position === 2 ? 'abc123' : 'top123' } }
  ] }];
  return f;
}

describe('one PR at a time in a native Stack', () => {
  it('allows #72 at the bottom and uses a HEAD-pinned async Squash without bypass', async () => {
    const { gh, api } = await stackFixture();
    expect(await integrate(gh, 72, 'alice', 'abc123')).toBe(true);
    const writes = api.calls.filter(c => c.route === submit);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args).toMatchObject({ pull_number: 72, sha: 'abc123', merge_method: 'squash', merge_action: 'direct_merge', bypass_rules: false,
      headers: { 'x-github-api-version': '2026-03-10' } });
    expect(api.stacks[0].pull_requests[1].state).toBe('open');
    expect(api.calls.some(c => c.route.endsWith('/merge'))).toBe(false);
  });
  it('allows independent review of #74, shows dev as its final target and blocks downstack integration', async () => {
    const { gh, api } = await stackFixture(2);
    const result = await gate(gh, api.pr);
    expect(result.reasons.join('\n')).toContain('先合并下层 PR：#72');
    expect(result.reasons.join('\n')).not.toContain('不允许普通集成');
    expect(result.progress.find(p => p.name === '人工审查')!.ready).toBe(true);
    await refreshPR(gh, 74);
    expect(api.pr.body).toContain('位置 2/2');
    expect(api.pr.body).toContain('最终目标 dev');
    expect(api.pr.body).toContain('直接父分支 feat/bottom');
    expect(api.pr.body).toContain('等待下层 #72');
    expect(await integrate(gh, 74, 'alice', 'abc123')).toBe(false);
    expect(api.calls.filter(c => c.route === submit)).toHaveLength(0);
  });
  it('rechecks a rebased upper PR after GitHub has merged the lower PR and updated its parent', async () => {
    const { gh, api } = await stackFixture(2);
    api.stacks[0].pull_requests[0].state = 'closed';
    api.stacks[0].pull_requests[0].merged_at = new Date().toISOString();
    expect((await gate(gh, api.pr)).ready).toBe(false); // Parent has not been updated yet.
    api.pr.base.ref = 'dev'; api.pr.head.sha = 'rebased';
    api.stacks[0].pull_requests[1].head.sha = 'rebased'; api.runs[0].head_sha = 'rebased';
    expect((await gate(gh, api.pr)).reasons.join('\n')).toContain('目前已有 0 位');
    api.reviews[0].commit_id = 'rebased';
    expect(await integrate(gh, 74, 'alice', 'rebased')).toBe(true);
  });
  it.each(['unavailable', 'missing', 'duplicate', 'closed', 'wrong-target'])('fails closed when the Stack is %s', async mode => {
    const { gh, api } = await stackFixture(2);
    if (mode === 'unavailable') api.extra = async route => { if (route === readStack) throw error(404, 'Unavailable'); };
    if (mode === 'missing') api.stacks = [];
    if (mode === 'duplicate') api.stacks[0].pull_requests.push(api.stacks[0].pull_requests[1]);
    if (mode === 'closed') api.stacks[0].pull_requests[0].state = 'closed';
    if (mode === 'wrong-target') { api.stacks[0].base.ref = 'main'; api.pr.stack!.base.ref = 'main'; }
    expect(await integrate(gh, 74, 'alice', 'abc123')).toBe(false);
    expect(api.calls.filter(c => c.route === submit)).toHaveLength(0);
  });
  it.each(['head', 'order', 'member', 'parent', 'unstack'])('rejects a changed %s immediately before submitting', async change => {
    const { gh, api } = await stackFixture();
    let reads = 0;
    api.extra = async route => {
      if (route === readPR && ++reads === 2) {
        if (change === 'head') api.pr.head.sha = 'changed';
        if (change === 'order') api.stacks[0].pull_requests.reverse();
        if (change === 'member') api.stacks[0].pull_requests[1].head.sha = 'changed';
        if (change === 'parent') api.pr.base.ref = 'other';
        if (change === 'unstack') api.pr.stack = null;
      }
    };
    expect(await integrate(gh, 72, 'alice', 'abc123')).toBe(false);
    expect(api.calls.filter(c => c.route === submit)).toHaveLength(0);
    expect(gh.commandResult).toContain('合并失败');
  });
});

describe('durable asynchronous integration', () => {
  it.each(['merged', 'enqueued'])('handles an immediate HTTP 200 / %s response', async status => {
    const f = await request();
    f.api.extra = async route => {
      if (route !== submit) return;
      if (status === 'merged') f.api.merged();
      return { status, details: { message: status, ...(status === 'merged' ? { sha: 'merge123' } : {}) } };
    };
    expect(await f.run()).toBe('ack');
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe(status);
    expect(f.api.pr.merged).toBe(status === 'merged');
  });
  it('tracks 202 → pending → merged through delayed jobs, preserving the command receipt and notification', async () => {
    const f = await request(); f.api.mergeResults = [f.api.pendingMerge()];
    expect(await f.run()).toBe('ack');
    expect(f.api.pr.merged).toBe(false);
    expect((await f.gh.records(1)).some(r => r.key === 'command-done:' + f.job.id)).toBe(true);
    const reply = f.api.comments.find(c => visibleComment(c.body).includes('GitHub 已受理'));
    expect(reply).toBeDefined();
    expect(await f.next()).toBe('ack');
    expect(f.api.pr.body).toContain('正在异步合并');
    expect(f.api.pr.body).not.toContain('上次 `/integrate` 只尝试一次');
    expect(await f.next()).toBe('ack');
    expect(f.api.pr.merged).toBe(true); expect(f.api.pr.body).toContain('**已合并**');
    expect(visibleComment(reply.body)).toContain('/commit/merge123');
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
    expect(f.api.calls.filter(c => c.route === poll)).toHaveLength(2);
    expect(f.env.TASKS.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge-poll' }), { delaySeconds: 30 });
  });
  it('reports GitHub failed results and never resubmits the same command', async () => {
    const f = await request(); f.api.mergeResults = [{ status: 'failed', details: { message: 'Required status check is missing.' } }];
    await f.run(); await f.next(); await f.run();
    const text = f.api.comments.map(c => visibleComment(c.body)).join('\n');
    expect(text).toContain('合并失败：Required status check is missing.');
    expect(f.api.pr.body).toContain('合并失败'); expect(f.api.pr.merged).toBe(false);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('recovers a matching 409 request by UUID', async () => {
    const f = await request();
    f.api.extra = async route => { if (route === submit) throw error(409, 'Already pending', f.api.pendingMerge()); };
    await f.run(); f.api.extra = undefined; await f.next();
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
    expect(f.api.calls.find(c => c.route === poll)!.args.uuid).toBe(f.api.mergeUUID);
    expect(f.api.pr.merged).toBe(true);
  });
  it.each(['merge-accepted:', 'merge-result:'])('recovers a lost %s receipt response without duplicate effects', async prefix => {
    const f = await request(), original = f.api.request.bind(f.api);
    let lost = false;
    f.api.request = async (route, args) => {
      const response = await original(route, args);
      if (!lost && route.startsWith('PATCH ') && args.body && decodeRecords({ body: args.body, id: 1, user: { login: 'piper[bot]', type: 'Bot' } }, 'piper[bot]', repo, 1).some(r => r.key.startsWith(prefix))) {
        lost = true; throw new Error('Receipt response lost');
      }
      return response;
    };
    if (prefix === 'merge-accepted:') {
      expect(await f.run()).toBe('retry'); expect(await f.run()).toBe('ack');
    } else {
      await f.run(); expect(await f.next()).toBe('retry'); expect(await f.next()).toBe('ack');
    }
    expect(f.api.pr.merged).toBe(true);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
    expect(f.api.comments.map(c => visibleComment(c.body)).join('\n')).toContain('/commit/merge123');
  });
  it.each([{ expected_head_sha: 'different' }, { merge_method: 'merge' }, { merge_action: 'merge_queue' }, { bypass_rules: true }, { bypass_rules: undefined }, { uuid: 'invalid' }])('refuses conflicting or unverifiable options %j', async mismatch => {
    const f = await request();
    f.api.extra = async route => { if (route === submit) throw error(409, 'Already pending', f.api.pendingMerge(mismatch)); };
    await f.run();
    expect(f.api.pr.merged).toBe(false);
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe('unknown');
    expect(f.api.comments.map(c => c.body).join('\n')).toContain('结果暂时无法确认');
  });
  it('does not mistake enqueued for merged or submit another request', async () => {
    const f = await request(); f.api.mergeResults = [{ status: 'enqueued', details: { message: 'Enqueued' } }];
    await f.run(); await f.next();
    await integrate(f.gh, 1, 'alice', 'abc123');
    f.gh.commandOrder = 100;
    await f.gh.record(1, 'command-state:later', { order: 100, actor: 'alice', head: 'abc123', change: { kind: 'integrate', mode: 'manual', cancelled: false } });
    await integrate(f.gh, 1, 'alice', 'abc123');
    expect(f.api.pr.merged).toBe(false); expect(f.api.pr.body).toContain('尚未合并');
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('recovers after a restart, duplicate deliveries and a lost polling task using reconciliation', async () => {
    const f = await request(); await f.run(); await f.run();
    (f.env.TASKS.send as any).mockClear();
    await processJob(f.env, { ...f.job, id: 'cron-recovery', kind: 'reconcile' }, f.api);
    expect(f.api.pr.merged).toBe(true);
    const writes = f.api.writes().length;
    await processJob(f.env, { ...f.job, id: 'duplicate', kind: 'reconcile' }, f.api);
    expect(f.api.writes()).toHaveLength(writes);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('observes the PR after a lost submission response without resending', async () => {
    const f = await request(), original = f.api.request.bind(f.api);
    f.api.request = async (route, args) => { const response = await original(route, args); if (route === submit) throw new Error('Response lost'); return response; };
    await f.run(); await f.run();
    expect((await prState(f.gh, f.api.pr)).merge?.accepted).toBeUndefined();
    await f.next(); expect(f.api.pr.merged).toBe(false);
    f.api.merged(); await f.next();
    expect(f.api.pr.merged).toBe(true); expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('retries a failed poll enqueue after command-done without resubmitting', async () => {
    const f = await request();
    (f.env.TASKS.send as any).mockRejectedValueOnce(new Error('Queue offline'));
    expect(await f.run()).toBe('retry'); expect(await f.run()).toBe('ack');
    // A status refresh also recovers a poll whose enqueue acknowledgement was lost.
    const status = queued(f.env).find(j => j.kind === 'status')!;
    await processJob(f.env, status, f.api);
    expect(f.api.pr.merged).toBe(true); expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it.each([400, 403, 404, 422])('makes a permanent submission HTTP %s error visible', async status => {
    const f = await request(); f.api.extra = async route => { if (route === submit) throw error(status, 'HTTP failure', { status: 'failed', details: { message: 'Specific GitHub rejection' } }); };
    expect(await f.run()).toBe('ack');
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe('failed');
    expect(f.api.comments.map(c => c.body).join('\n')).toContain('Specific GitHub rejection');
    expect(queued(f.env).some(j => j.kind === 'merge-poll')).toBe(false);
  });
  it.each([403, 429])('distinguishes HTTP %s rate limits from an ambiguous submission', async status => {
    const f = await request();
    f.api.extra = async route => { if (route === submit) throw error(status, 'Rate limit', undefined, { 'retry-after': '60' }); };
    await f.run();
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe('failed');
    expect(f.api.comments.map(c => c.body).join('\n')).toContain('暂时限流');
    expect(queued(f.env).some(j => j.kind === 'merge-poll')).toBe(false);
  });
  it('limits temporary query failures using new delayed tasks and makes exhaustion visible', async () => {
    const f = await request(); await f.run();
    f.api.extra = async route => { if (route === poll) throw new Error('Timed out'); };
    for (let n = 0; n < 5; n++) expect(await f.next()).toBe('ack');
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe('unknown');
    expect(f.api.comments.map(c => c.body).join('\n')).toContain('Timed out');
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('schedules a fresh task when the confirmation read times out after GitHub accepts the request', async () => {
    const f = await request();
    let reads = 0;
    f.api.extra = async route => { if (route === readPR && ++reads === 4) throw new Error('Confirmation timed out'); };
    // executeCommand reads once, integration twice, then confirms the accepted request.
    expect(await f.run()).toBe('ack');
    expect(queued(f.env).some(j => j.kind === 'merge-poll' && j.failures === 1)).toBe(true);
    f.api.extra = undefined; await f.next();
    expect(f.api.pr.merged).toBe(true); expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it.each([false, true])('checks the actual PR before stopping after 24 hours (merged=%s)', async merged => {
    const f = await request(); await f.run();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + MERGE_RETENTION_MS + 1);
    if (merged) f.api.merged();
    await f.next();
    expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe(merged ? 'merged' : 'unknown');
    expect(f.api.calls.filter(c => c.route === poll)).toHaveLength(0);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('stops safely on an expired UUID and does not trust malformed or legacy results', async () => {
    for (const response of [undefined, { merged: true, sha: 'old-api' }]) {
      const f = await request(); await f.run();
      f.api.extra = async route => { if (route === poll) { if (!response) throw error(404, 'Expired UUID'); return response; } };
      await f.next();
      expect((await prState(f.gh, f.api.pr)).merge?.result?.status).toBe('unknown');
      expect(f.api.pr.merged).toBe(false);
    }
  });
  it('keeps tracking the original request when HEAD changes, without submitting for the new HEAD', async () => {
    const f = await request(); await f.run(); f.api.pr.head.sha = 'newhead';
    f.api.mergeResults = [{ status: 'failed', details: { message: 'Head changed.' } }];
    await f.next();
    expect(f.api.pr.merged).toBe(false); expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
    expect(f.api.comments.map(c => visibleComment(c.body)).join('\n')).toContain('Head changed.');
    expect(f.api.pr.body).toContain('旧的集成请求已失效');
  });
  it('keeps policy auto off for high risk changes and retains the current-head approval gate', async () => {
    const f = await fixture('merge:\n  auto: true'); f.api.files = [{ filename: 'migrations/change.sql' }];
    await reconcilePR(f.gh, 1);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(0);
    f.api.reviews[0].commit_id = 'old';
    expect(await integrate(f.gh, 1, 'alice', 'abc123')).toBe(false);
    f.api.reviews[0].commit_id = 'abc123';
    expect(await integrate(f.gh, 1, 'alice', 'abc123')).toBe(true);
  });
  it('keeps policy merge completion idempotent without creating a second notice', async () => {
    const f = await fixture('merge:\n  auto: true'); f.api.config += 'merge:\n  auto: true';
    const job: Job = { id: 'policy', repo, installation: 1, kind: 'reconcile', number: 1, time: new Date().toISOString() };
    await processJob(f.env, job, f.api);
    const writes = f.api.writes().length;
    await processJob(f.env, { ...job, id: 'policy-again' }, f.api);
    expect(f.api.writes()).toHaveLength(writes);
    expect(f.api.comments.filter(c => visibleComment(c.body).includes('/commit/merge123'))).toHaveLength(1);
  });
  it('restores the ready preview when a failed request is followed by a new approved HEAD', async () => {
    const f = await request(); f.api.mergeResults = [{ status: 'failed', details: { message: 'Previous attempt failed.' } }];
    await f.run(); await f.next();
    f.api.pr.head.sha = 'newhead'; f.api.runs[0].head_sha = 'newhead'; f.api.reviews[0].commit_id = 'newhead';
    await processJob(f.env, { ...f.job, id: 'updated', kind: 'reconcile' }, f.api);
    expect(f.api.pr.body).toContain('检查已满足，等待合并');
    const ready = f.api.comments.find(c => c.body.startsWith('<!-- piper:ready -->'));
    expect(visibleComment(ready.body)).toContain('当前提交 `newhead`');
    expect(visibleComment(ready.body)).toContain('/integrate');
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
  it('does not write receipts or submit merges in dry-run', async () => {
    const { gh, api } = await fixture('', { DRY_RUN: 'true' });
    await integrate(gh, 1, 'alice', 'abc123');
    expect(api.writes()).toHaveLength(0); expect(await gh.records(1)).toHaveLength(0);
  });
  it('restores tracking from native records using a fresh GitHub client', async () => {
    const f = await request(); await f.run();
    const fresh = new GitHub(f.env, repo, 'restart', f.api); fresh.config = f.gh.config;
    expect(await trackMerge(fresh, 1)).toBe(true);
    expect(f.api.calls.filter(c => c.route === submit)).toHaveLength(1);
  });
});
