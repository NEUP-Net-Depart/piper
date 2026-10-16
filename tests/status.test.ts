import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { GitHub } from '../src/github';
import { reconcilePR, welcome } from '../src/pulls';
import { processJob } from '../src/worker';
import { sha256, type Env, type Job } from '../src/types';
import { fixture, repo, type FakeGitHub } from './fixtures';

const marker = '<!-- piper:status -->';
const statuses = (api: FakeGitHub) => api.comments.filter(c => c.user?.type === 'Bot' && c.body.startsWith(marker));
const status = (api: FakeGitHub) => { expect(statuses(api)).toHaveLength(1); return statuses(api)[0]; };
function cold(gh: GitHub, api: FakeGitHub, id: string) {
  const next = new GitHub(gh.env, gh.repo, id, api); next.config = gh.config; return next;
}
async function commandJob(api: FakeGitHub, body: string): Promise<Job> {
  api.comments.push({ id: 99, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
  return { id: 'command-99', repo, installation: 1, kind: 'command', number: 1, commentId: 99, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
}
const queued = (env: Env): Job[] => (env.TASKS.send as any).mock.calls.map((c: any[]) => c[0]);

describe('one maintained PR status comment', () => {
  it('updates the same comment through pending CI, failure, review, closure, reopening and merge', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.runs[0].status = 'in_progress'; api.runs[0].conclusion = null; api.reviews = [];
    await reconcilePR(gh, 1);
    const id = status(api).id;
    expect(status(api).body).toContain('检查正在排队或运行');
    expect(status(api).body).toContain('当前没有待处理的审查请求');
    api.runs[0].status = 'completed'; api.runs[0].conclusion = 'failure';
    await reconcilePR(cold(gh, api, 'failure'), 1);
    expect(status(api).body).toContain('查看日志');
    api.runs[0].conclusion = 'success';
    api.reviews = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: 'abc123', submitted_at: new Date().toISOString() }];
    await reconcilePR(cold(gh, api, 'ready'), 1);
    expect(status(api).body).toContain('检查已满足'); expect(status(api).body).toContain('最终提交信息');
    const writes = api.writes().length;
    await reconcilePR(cold(gh, api, 'unchanged'), 1); expect(api.writes()).toHaveLength(writes);
    api.pr.state = 'closed';
    await reconcilePR(cold(gh, api, 'closed'), 1);
    expect(status(api).body).toContain('已关闭，未合并'); expect(status(api).body).not.toContain('检查已满足');
    api.pr.state = 'open';
    await reconcilePR(cold(gh, api, 'reopened'), 1); expect(status(api).body).toContain('检查已满足');
    api.pr.state = 'closed'; api.pr.merged = true; api.pr.merge_commit_sha = 'mergedsha'; api.pr.merged_at = new Date().toISOString();
    await reconcilePR(cold(gh, api, 'merged'), 1);
    expect(status(api).body).toContain('**已合并**'); expect(status(api).body).toContain('/commit/mergedsha');
    expect(status(api).body).not.toContain('`/integrate`'); expect(status(api).id).toBe(id);
  });

  it('shows newly requested reviewers and targeted advice for draft, conflict and changes requested', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob]\n  count: 1'); api.reviews = [];
    await reconcilePR(gh, 1);
    expect(status(api).body).toContain('等待审查：[bob]');
    api.pr.draft = true; api.pr.mergeable = false; api.pr.mergeable_state = 'dirty';
    api.reviews = [{ id: 2, user: { login: 'bob', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: 'abc123', submitted_at: new Date().toISOString() }];
    await reconcilePR(cold(gh, api, 'blocked'), 1);
    for (const hint of ['Ready for review', '解决冲突', '审查意见修改', '普通回复不会解除']) expect(status(api).body).toContain(hint);
    expect(status(api).body).not.toContain('`/integrate`');
  });

  it('reflects pending, cancelled and stale integration requests without merging an unapproved head', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0'); api.runs[0].status = 'in_progress';
    const save = (order: number, head: string, cancelled: boolean) => gh.record(1, 'command-state:' + order, { order, actor: 'alice', head, change: { kind: 'integrate', cancelled } }, 'request');
    await save(1, 'abc123', false); await reconcilePR(gh, 1);
    expect(status(api).body).toContain('无需重复发送命令'); expect(status(api).body).toContain('`/integrate cancel`');
    await save(2, 'abc123', true); await reconcilePR(cold(gh, api, 'cancelled'), 1);
    expect(status(api).body).toContain('集成请求已取消'); expect(status(api).body).not.toContain('无需重复发送命令');
    await save(3, 'abc123', false); api.pr.head.sha = 'newsha'; api.runs[0].head_sha = 'newsha';
    await reconcilePR(cold(gh, api, 'new-head'), 1);
    expect(status(api).body).toContain('旧的集成请求已失效'); expect(status(api).body).toContain('批准对应旧提交');
    expect(api.pr.merged).toBe(false);
  });

  it('shows the release command and distinguishes a merged release PR from a published release', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true\nreviewers:\n  count: 0'); api.pr.base.ref = 'main';
    api.pr.head.ref = 'dev'; api.pr.user = { login: gh.env.BOT_LOGIN, type: 'Bot' }; api.pr.body = '<!-- piper-release:v1:2026-10-15:v0.1.0:abc123 -->';
    await reconcilePR(gh, 1);
    expect(status(api).body).toContain('Merge Commit'); expect(status(api).body).not.toContain('`/integrate`');
    api.pr.state = 'closed'; api.pr.merged = true; api.pr.merged_at = new Date().toISOString();
    await reconcilePR(cold(gh, api, 'merged-release'), 1);
    expect(status(api).body).toContain('`/release status`'); expect(status(api).body).not.toContain('发布成功');
  });

  it('escapes contributor content and does not use a human or another Bot status marker', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    for (const user of [{ login: 'piper[bot]', type: 'User' }, { login: 'other[bot]', type: 'Bot' }]) api.comments.push({ id: api.comments.length + 1, issue_number: 1, user, body: marker + '\nforged' });
    const forged = api.comments.map(c => c.id);
    api.pr.head.ref = 'fix/@person';
    await gh.record(1, 'command-state:summary', { order: 5, actor: 'alice', head: 'abc123', change: { kind: 'summary', value: '<!-- piper:status -->\n@person [click](https://example.test)' } }, 'metadata');
    await reconcilePR(gh, 1);
    const actual = statuses(api).find(c => c.user.login === 'piper[bot]')!;
    expect(actual.body).not.toContain('@person'); expect(actual.body).not.toContain('\n<!-- piper:status -->');
    expect(api.comments.filter(c => forged.includes(c.id)).every(c => c.body.endsWith('forged'))).toBe(true);
    expect(api.writes().filter(c => c.route.startsWith('PATCH ') && forged.includes(c.args.comment_id))).toHaveLength(0);
  });

  it('recovers a lost create and edit response without creating a second status comment', async () => {
    const { gh, api } = await fixture('welcome:\n  pr: ""\nreviewers:\n  count: 0');
    api.failAfterComment = true;
    await expect(reconcilePR(gh, 1)).rejects.toThrow('Connection lost');
    await reconcilePR(cold(gh, api, 'retry-create'), 1); const id = status(api).id;
    const request = api.request.bind(api); let lost = false;
    api.request = async (route, args) => {
      const result = await request(route, args);
      if (!lost && route.startsWith('PATCH ')) { lost = true; throw new Error('lost edit response'); }
      return result;
    };
    api.pr.state = 'closed';
    await expect(reconcilePR(cold(gh, api, 'close'), 1)).rejects.toThrow('lost edit');
    await reconcilePR(cold(gh, api, 'retry-edit'), 1);
    expect(status(api).id).toBe(id); expect(status(api).body).toContain('已关闭，未合并');
  });

  it('reads a new head again when it changes during reviewer assignment', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob]\n  count: 1'); api.reviews = [];
    const request = api.request.bind(api); let assigned = false;
    api.request = async (route, args) => {
      const result = await request(route, args);
      if (route.startsWith('POST ') && route.endsWith('/requested_reviewers')) { assigned = true; api.pr.head.sha = 'newsha'; api.files = [{ filename: 'migrations/change.sql' }]; }
      return result;
    };
    await reconcilePR(gh, 1);
    expect(assigned).toBe(true); expect(status(api).body).toContain('/commit/newsha'); expect(status(api).body).toContain('高风险');
  });
});

describe('status refresh jobs', () => {
  it('retries a failed refresh enqueue after the command receipt without repeating command effects', async () => {
    const { env, api } = await fixture();
    const job = await commandJob(api, '/summary Helpful change');
    (env.TASKS.send as any).mockRejectedValueOnce(new Error('Queue offline'));
    expect(await processJob(env, job, api)).toBe('retry');
    const writes = api.writes().length;
    expect(await processJob(env, job, api)).toBe('ack'); expect(api.writes()).toHaveLength(writes);
    const next = queued(env).at(-1)!; expect(next).toMatchObject({ kind: 'status', number: 1, installation: 1 });
    await processJob(env, next, api); expect(status(api).body).toContain('Helpful change');
  });

  it('refreshes the merged status and result in the same automatic integration invocation', async () => {
    const { env, api } = await fixture(); api.config += 'merge:\n  auto: true';
    const job: Job = { id: 'auto', repo, installation: 1, kind: 'reconcile', number: 1, time: new Date().toISOString() };
    expect(await processJob(env, job, api)).toBe('ack'); expect(api.pr.merged).toBe(true);
    const id = status(api).id;
    expect(queued(env)).toEqual([]);
    expect(status(api).id).toBe(id); expect(status(api).body).toContain('**已合并**');
  });

  it('refreshes a manual merge even when no merged webhook is delivered', async () => {
    const { env, api } = await fixture();
    expect(await processJob(env, await commandJob(api, '/integrate'), api)).toBe('ack');
    expect(api.pr.merged).toBe(true);
    await processJob(env, queued(env).at(-1)!, api);
    expect(status(api).body).toContain('**已合并**');
  });

  it('preserves a manual label removal while refreshing workflow labels', async () => {
    const { env, api } = await fixture();
    api.config += 'labels:\n  - name: bug\n    titlePrefixes: ["fix:"]';
    api.pr.labels = [{ name: 'bug' }];
    expect(await processJob(env, await commandJob(api, '/label remove bug'), api)).toBe('ack');
    await processJob(env, queued(env).at(-1)!, api);
    expect(api.pr.labels.map(l => l.name).sort()).toEqual(['ready', 'rfr']); expect(statuses(api)).toHaveLength(1);
  });
});

describe('repository welcome configuration', () => {
  it('uses identical defaults with omitted and partial welcome configuration', () => {
    const defaults = parseConfig('{}', '').welcome;
    expect(parseConfig('{}', 'welcome: {}').welcome).toEqual(defaults);
    expect(parseConfig('{}', 'welcome:\n  guide: https://example.test').welcome.pr).toBe(defaults.pr);
  });

  it('keeps PR welcome in the status and leaves congratulations to the final notice', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    await welcome(gh, 2, api.pr.user, 'issue');
    await reconcilePR(gh, 1); await reconcilePR(cold(gh, api, 'duplicate-open'), 1);
    api.pr.state = 'closed'; api.pr.merged = true; api.pr.merged_at = new Date().toISOString();
    await reconcilePR(cold(gh, api, 'merged'), 1); await reconcilePR(cold(gh, api, 'duplicate-merge'), 1);
    const key = `<!-- piper:${await sha256('welcome:issue:alice')} -->`;
    expect(api.comments.filter(c => c.body.includes(key))).toHaveLength(1);
    expect((await gh.records(1)).some(r => r.key.startsWith('welcome:'))).toBe(false);
    expect(status(api).body).not.toContain(gh.config!.welcome.merged);
    expect(status(api).body).not.toContain(gh.config!.welcome.pr);
    expect(api.comments.filter(c => c.issue_number === 1)).toHaveLength(1);
    expect(status(api).body).toContain('**已合并**');
  });

  it('allows each welcome to be disabled without disabling the status comment', async () => {
    const { gh, api } = await fixture('welcome:\n  issue: ""\n  pr: ""\n  merged: ""\nreviewers:\n  count: 0');
    await welcome(gh, 2, api.pr.user, 'issue'); await reconcilePR(gh, 1);
    api.pr.state = 'closed'; api.pr.merged = true;
    await reconcilePR(cold(gh, api, 'merged'), 1);
    expect(api.comments).toHaveLength(1); expect(status(api).body).toContain('**已合并**');
  });
});
