import { describe, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github';
import { parseConfig } from '../src/config';
import { gate, reconcilePR, refreshPR, rotate, assign, checks } from '../src/pulls';
import { processJob } from '../src/worker';
import { prState, visibleComment } from '../src/records';
import { READY_MARKER, PROGRESS_START } from '../src/status';
import { fixture, repo, type FakeGitHub } from './fixtures';
import type { Job } from '../src/types';

const cold = (gh: GitHub, api: FakeGitHub) => {
  const next = new GitHub(gh.env, gh.repo, 'refresh', api);
  next.config = gh.config;
  return next;
};
const body = (api: FakeGitHub, marker = PROGRESS_START) =>
  marker === PROGRESS_START ? api.pr.body! : visibleComment(api.comments.find((c) => c.body.startsWith(marker))!.body);
const job = (id: string): Job => ({
  id,
  repo,
  installation: 1,
  kind: 'status',
  number: 1,
  time: new Date().toISOString(),
});

describe('CI startup lifecycle', () => {
  it('starts a new head clock on an old PR, persists it over restart, and refreshes at expiry', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = Date.parse('2026-10-18T12:00:00Z');
    clock.mockReturnValue(now);
    try {
      const { gh, env, api } = await fixture();
      await gate(gh, api.pr);
      clock.mockReturnValue(now + 3 * 86400000);
      api.pr.head.sha = 'newsha';
      api.runs = [];
      expect(await processJob(env, job('push'), api)).toBe('ack');
      expect(body(api)).toContain('等待 CI 启动');
      const send = vi.mocked(env.TASKS.send);
      const delayed = send.mock.calls.find(([, options]) => options?.delaySeconds === 300)!;
      expect(delayed[0]).toMatchObject({ kind: 'status', head: 'newsha' });
      clock.mockReturnValue(now + 3 * 86400000 + 299000);
      expect(await processJob(env, job('unrelated-comment'), api)).toBe('ack');
      expect(send.mock.calls.filter(([, options]) => options?.delaySeconds)).toHaveLength(1);
      clock.mockReturnValue(now + 3 * 86400000 + 300000);
      expect(await processJob(env, delayed[0] as Job, api)).toBe('ack');
      expect(body(api).split('<details>')[0]).toContain('检查工作流配置');
      expect(api.pr.merged).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('retries a failed delayed send without resetting the observation', async () => {
    const { env, api, gh } = await fixture();
    api.runs = [];
    vi.mocked(env.TASKS.send).mockRejectedValueOnce(new Error('Queue unavailable'));
    expect(await processJob(env, job('missing'), api)).toBe('retry');
    const seen = await gh.getRecord(1, 'ci-head-seen:abc123');
    expect(await gh.getRecord(1, 'ci-startup-queued:abc123')).toBeUndefined();
    expect(await processJob(env, job('missing'), api)).toBe('ack');
    expect(await gh.getRecord(1, 'ci-head-seen:abc123')).toEqual(seen);
    expect(await gh.getRecord(1, 'ci-startup-queued:abc123')).toBeDefined();
  });

  it('does not apply an old delayed job deadline to a newer head or reopen a closed PR', async () => {
    const { env, api } = await fixture();
    api.runs = [];
    await processJob(env, job('first'), api);
    const delayed = vi.mocked(env.TASKS.send).mock.calls[0]![0] as Job;
    api.pr.head.sha = 'second';
    await processJob(env, delayed, api);
    expect(body(api)).toContain('等待 CI 启动');
    expect(vi.mocked(env.TASKS.send).mock.calls.at(-1)![0]).toMatchObject({ head: 'second' });
    const sends = vi.mocked(env.TASKS.send).mock.calls.length;
    api.pr.state = 'closed';
    await processJob(env, delayed, api);
    expect(body(api)).toContain('已关闭');
    expect(vi.mocked(env.TASKS.send)).toHaveBeenCalledTimes(sends);
  });
});

describe('review responsibility and permissions', () => {
  it('assigns the action to Carol after a handoff, keeping Bob only in history', async () => {
    const { gh, api } = await fixture();
    api.reviews[0].commit_id = 'old';
    api.pr.requested_reviewers = [{ login: 'carol' }];
    await refreshPR(gh, 1);
    const first = body(api).split('<details>')[0]!;
    expect(first).toContain('**审查者** [carol]');
    expect(first).not.toContain('[bob]');
    expect(body(api)).toContain('该历史批准不代表当前审查任务');
  });

  it('removes the auto label and renders recovery when the request actor loses write access', async () => {
    const { gh, api } = await fixture();
    await gh.record(1, 'command-state:auto', {
      order: 1,
      head: 'abc123',
      actor: 'alice',
      change: { kind: 'integrate', cancelled: false, mode: 'auto' },
    });
    api.pr.labels = [{ name: 'auto' }];
    api.permissions.alice = 'read';
    await reconcilePR(cold(gh, api), 1, true);
    expect(api.pr.merged).toBe(false);
    expect(api.pr.labels.map((l) => l.name)).not.toContain('auto');
    for (const marker of [PROGRESS_START, READY_MARKER]) {
      expect(body(api, marker)).toContain('请求人已无仓库写权限');
      expect(body(api, marker)).not.toContain('已开启自动集成');
    }
    expect((await prState(gh, api.pr)).integrate_actor).toBe('alice');
  });

  it('can reuse a historical reviewer after cooldown, but not a recently removed one', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob, carol]');
    api.reviews = [];
    api.pr.requested_reviewers = [{ login: 'carol' }];
    api.timeline = [
      {
        id: 1,
        event: 'review_requested',
        requested_reviewer: { login: 'bob' },
        created_at: new Date(Date.now() - 100 * 3600000).toISOString(),
      },
      {
        id: 2,
        event: 'review_requested',
        requested_reviewer: { login: 'carol' },
        created_at: new Date(Date.now() - 50 * 3600000).toISOString(),
      },
      {
        id: 3,
        event: 'review_request_removed',
        requested_reviewer: { login: 'bob' },
        created_at: new Date().toISOString(),
      },
    ];
    await rotate(gh, api.pr);
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
    api.timeline[2].created_at = new Date(Date.now() - 49 * 3600000).toISOString();
    await rotate(cold(gh, api), api.pr);
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
  });

  it('can fill an empty queue with a cooled-down historical reviewer', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob]');
    api.reviews = [];
    api.timeline = [
      {
        id: 1,
        event: 'review_requested',
        requested_reviewer: { login: 'bob' },
        created_at: new Date(Date.now() - 49 * 3600000).toISOString(),
      },
    ];
    expect(await assign(gh, api.pr)).toEqual(['bob']);
  });
});

describe('safe merge readiness', () => {
  it('does not accept a successful same-name check or commit status without a trusted App', async () => {
    const { gh, api } = await fixture();
    gh.config = parseConfig('{}', 'enabled: true\ndryRun: false');
    api.statuses = [{ id: 2, context: 'verify', state: 'success' }];
    expect(await checks(gh, 'abc123', ['verify'])).toEqual(['未配置可信 CI 应用']);
    gh.config.merge.trustedCheckAppIds = [1];
    api.runs[0].app.id = 999;
    expect(await checks(gh, 'abc123', ['verify'])).toContain('CI 缺失：verify');
    api.runs.push({ ...api.runs[0], id: 3, app: { id: 1 }, status: 'in_progress', conclusion: null });
    expect(await checks(gh, 'abc123', ['verify'])).toContain('CI 未成功：verify');
  });

  it('keeps status, notice, labels and automatic execution blocked for 250 commits', async () => {
    const { gh, api } = await fixture('merge:\n  auto: true');
    api.extra = async (route, args) =>
      route.endsWith('/pulls/{pull_number}/commits')
        ? Array.from({ length: args.page <= 2 ? 100 : 50 }, () => ({
            commit: { author: { name: 'Alice', email: 'a@example.test' } },
          }))
        : undefined;
    await reconcilePR(gh, 1, true);
    expect(api.pr.merged).toBe(false);
    expect(body(api).split('<details>')[0]).not.toContain('`/integrate`');
    expect(body(api)).toContain('250 条读取上限');
    expect(api.pr.labels.map((l) => l.name)).not.toContain('ready');
    expect(api.comments.some((c) => c.body.startsWith(READY_MARKER))).toBe(false);
  });
});
