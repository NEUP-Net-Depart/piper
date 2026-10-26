import { describe, expect, it, vi } from 'vitest';
import worker, { app } from '../src/index';
import { processJob, tick } from '../src/worker';
import { assign, rotate, welcome } from '../src/pulls';
import { GitHub } from '../src/github';
import { sha256, type Env, type Job } from '../src/types';
import { fixture, FakeGitHub, repo, testEnv } from './fixtures';
import { prepareRelease, publishRelease, releaseFor, syncRelease } from '../src/releases';

async function webhook(
  body: string,
  e = testEnv(),
  event = 'pull_request',
  signature?: string,
  delivery = 'delivery-123456',
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(e.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig =
    'sha256=' +
    [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  return app.request(
    '/webhooks/github',
    {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': signature ?? sig },
      body,
    },
    e,
  );
}
const event = () => ({
  action: 'opened',
  installation: { id: 1 },
  repository: { full_name: repo },
  sender: { login: 'alice', type: 'User' },
  pull_request: { number: 1, user: { login: 'alice', type: 'User' } },
});
const jobs = (e: Env): Job[] => (e.TASKS.send as any).mock.calls.map((x: any[]) => x[0]);
const fresh = (gh: GitHub, api: FakeGitHub) => {
  const next = new GitHub(gh.env, gh.repo, gh.job, api);
  next.config = gh.config;
  next.commandOrder = gh.commandOrder;
  return next;
};

describe('database-free webhook and Queue ingress', () => {
  it('ignores Piper description/label/review echoes and incomplete workflow notifications, preserving human changes', async () => {
    for (const action of ['edited', 'labeled', 'unlabeled', 'review_requested', 'review_request_removed']) {
      const e = testEnv();
      const payload = { ...event(), action, sender: { login: e.BOT_LOGIN, type: 'Bot' } };
      expect((await webhook(JSON.stringify(payload), e)).status).toBe(202);
      expect(jobs(e)).toHaveLength(0);
      payload.sender = { login: 'alice', type: 'User' };
      expect((await webhook(JSON.stringify(payload), e)).status).toBe(202);
      expect(jobs(e)).toHaveLength(1);
    }
    const e = testEnv();
    await webhook(JSON.stringify({ ...event(), action: 'in_progress' }), e, 'workflow_run');
    expect(jobs(e)).toHaveLength(0);
    await webhook(
      JSON.stringify({ ...event(), action: 'completed', workflow_run: { pull_requests: [{ number: 1 }] } }),
      e,
      'workflow_run',
    );
    expect(jobs(e)).toHaveLength(1);
  });
  it('still handles other Bot edits and Piper PR lifecycle events', async () => {
    const e = testEnv();
    await webhook(JSON.stringify({ ...event(), action: 'edited', sender: { login: 'other[bot]', type: 'Bot' } }), e);
    for (const action of ['opened', 'closed', 'reopened', 'synchronize']) {
      await webhook(JSON.stringify({ ...event(), action, sender: { login: e.BOT_LOGIN, type: 'Bot' } }), e);
    }
    expect(jobs(e)).toHaveLength(5);
    expect(jobs(e).every((j) => j.kind === 'reconcile' && j.number === 1)).toBe(true);
  });
  it('skips unrelated CI jobs after loading the repository configuration', async () => {
    const e = testEnv(),
      api = new FakeGitHub();
    await webhook(
      JSON.stringify({
        ...event(),
        action: 'completed',
        check_run: { name: 'optional-check', pull_requests: [{ number: 1 }] },
      }),
      e,
      'check_run',
    );
    expect(await processJob(e, jobs(e)[0]!, api)).toBe('ack');
    expect(api.writes()).toHaveLength(0);
    expect(jobs(e)).toHaveLength(1);
  });
  it('targets CI notifications at every related PR without scanning unrelated or closed PRs', async () => {
    const e = testEnv();
    const payload = {
      ...event(),
      action: 'completed',
      check_run: { pull_requests: [{ number: 1 }, { number: 2 }, { number: 1 }] },
    };
    expect((await webhook(JSON.stringify(payload), e, 'check_run')).status).toBe(202);
    expect(jobs(e).map((j) => [j.kind, j.number])).toEqual([
      ['reconcile', 1],
      ['reconcile', 2],
    ]);
    const other = testEnv(),
      api = new FakeGitHub();
    api.pr.state = 'closed';
    const job: Job = {
      id: 'ci-without-related-pr',
      repo,
      installation: 1,
      kind: 'scan',
      time: new Date().toISOString(),
    };
    await processJob(other, job, api);
    expect(jobs(other).some((j) => j.kind === 'reconcile')).toBe(false);
    await processJob(other, { ...job, id: 'recovery', includeClosed: true }, api);
    expect(jobs(other).some((j) => j.kind === 'reconcile' && j.number === 1)).toBe(true);
  });
  it('rejects invalid signatures before enqueue', async () => {
    const e = testEnv();
    expect((await webhook(JSON.stringify(event()), e, 'pull_request', 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect(jobs(e)).toHaveLength(0);
  });
  it('sends compact jobs and reconciles duplicate deliveries after a cold start', async () => {
    const e = testEnv(),
      api = new FakeGitHub();
    api.config += 'labels:\n  - name: bug\n    titlePrefixes: ["fix:"]';
    const payload = JSON.stringify({ ...event(), largeUnusedField: 'x'.repeat(200000) });
    expect((await webhook(payload, e)).status).toBe(202);
    expect((await webhook(payload, e, 'pull_request', undefined, 'other-delivery-1234')).status).toBe(202);
    expect(JSON.stringify(jobs(e)[0]).length).toBeLessThan(1024);
    expect(jobs(e)[0]?.id).toBe(jobs(e)[1]?.id);
    await processJob(e, jobs(e)[0]!, api);
    const count = api.writes().length;
    await processJob(e, jobs(e)[1]!, api);
    expect(api.writes()).toHaveLength(count);
    expect(api.pr.labels).toContainEqual({ name: 'bug' });
    expect(jobs(e).map((j) => j.kind)).toEqual(['reconcile', 'reconcile']);
  });
  it('returns failure if Queue send fails; GitHub redelivery supplies recovery', async () => {
    const e = testEnv();
    (e.TASKS.send as any).mockRejectedValueOnce(new Error('queue offline'));
    expect((await webhook(JSON.stringify(event()), e)).status).toBe(500);
    expect((await webhook(JSON.stringify(event()), e)).status).toBe(202);
    expect(jobs(e)).toHaveLength(2);
  });
  it('does not enqueue Bot comment feedback loops', async () => {
    const e = testEnv();
    const data = {
      ...event(),
      action: 'created',
      issue: { number: 1 },
      comment: { id: 10, body: '/help', user: { login: 'piper[bot]', type: 'Bot' } },
    };
    expect((await webhook(JSON.stringify(data), e, 'issue_comment')).status).toBe(202);
    expect(jobs(e)).toHaveLength(0);
  });
  it('ignores tag feedback, carries CI scope and distinguishes configuration pushes', async () => {
    const e = testEnv(),
      sha = 'a'.repeat(40);
    expect((await webhook(JSON.stringify({ ...event(), ref: 'refs/tags/v1.0.0', after: sha }), e, 'push')).status).toBe(
      202,
    );
    expect(jobs(e)).toHaveLength(0);
    await webhook(
      JSON.stringify({
        ...event(),
        action: 'completed',
        workflow_run: { path: '.github/workflows/ci.yml@refs/heads/dev', head_sha: sha, head_branch: 'dev' },
      }),
      e,
      'workflow_run',
    );
    expect(jobs(e)[0]).toMatchObject({ head: sha, branch: 'dev', workflow: 'ci.yml', syncOnly: true });
    expect(jobs(e)[0]?.baseChanged).toBeUndefined();
    await webhook(
      JSON.stringify({
        ...event(),
        repository: { full_name: repo, default_branch: 'dev' },
        ref: 'refs/heads/dev',
        after: sha,
        commits: [{ modified: ['.piper.yml'] }],
      }),
      e,
      'push',
    );
    expect(jobs(e)[1]).toMatchObject({ baseChanged: true, configChanged: true });
  });
  it('marks repository-changing commands for coordination without coalescing their identities', async () => {
    const e = testEnv();
    for (const [id, body] of [
      [1, '/summary Change'],
      [2, '/release prepare'],
      [3, '/backport maintenance'],
      [4, '/tag candidate'],
    ] as const) {
      await webhook(
        JSON.stringify({
          ...event(),
          action: 'created',
          issue: { number: 1 },
          comment: { id, body, user: { login: 'alice', type: 'User' } },
        }),
        e,
        'issue_comment',
      );
    }
    expect(jobs(e).map((j) => j.repository)).toEqual([false, true, true, true]);
    expect(new Set(jobs(e).map((j) => j.id)).size).toBe(4);
  });
  it('rejects oversized command text as a client error without enqueueing', async () => {
    const e = testEnv();
    const data = {
      ...event(),
      action: 'created',
      issue: { number: 1 },
      comment: { id: 10, body: '/summary ' + 'x'.repeat(10000), user: { login: 'alice', type: 'User' } },
    };
    expect((await webhook(JSON.stringify(data), e, 'issue_comment')).status).toBe(400);
    expect(jobs(e)).toHaveLength(0);
  });
  it('discovers installations from the allowlist and scans existing PRs without registration', async () => {
    const e = testEnv(),
      api = new FakeGitHub();
    await tick(e, new Date(), api);
    expect(jobs(e)[0]).toMatchObject({ repo: repo.toLowerCase(), installation: 1, kind: 'scan' });
    await processJob(e, jobs(e)[0]!, api);
    expect(jobs(e).some((j) => j.kind === 'reconcile' && j.number === 1)).toBe(true);
  });
  it('retries transient failures using Queue attempts, with no in-memory job database', async () => {
    const e = testEnv(),
      api = new FakeGitHub(),
      job: Job = { id: 'retry', repo, installation: 1, kind: 'reconcile', number: 1, time: new Date().toISOString() };
    api.extra = async () => {
      throw new Error('offline');
    };
    expect(await processJob(e, job, api)).toBe('retry');
    api.extra = undefined;
    expect(await processJob(e, job, api)).toBe('ack');
    e.EMERGENCY_STOP = 'true';
    const message = { body: job, attempts: 3, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] } as unknown as MessageBatch<Job>, e);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(message.ack).not.toHaveBeenCalled();
  });
  it('re-reads current command body and rejects edited commands', async () => {
    const e = testEnv(),
      api = new FakeGitHub();
    api.comments = [
      {
        id: 99,
        issue_number: 1,
        body: '/label add exploit',
        user: { login: 'alice', type: 'User' },
        issue_url: `https://api.github.com/repos/${repo}/issues/1`,
      },
    ];
    const job: Job = {
      id: 'command-test',
      repo,
      installation: 1,
      kind: 'command',
      number: 1,
      commentId: 99,
      actor: 'alice',
      bodyHash: await sha256('/integrate'),
      time: new Date().toISOString(),
    };
    expect(await processJob(e, job, api)).toBe('ack');
    expect(api.writes()).toHaveLength(0);
    expect(api.calls.find((x) => x.route.includes('/contents/'))?.args.ref).toBe('main');
  });
  it('command receipts stop replays after labels are changed by humans', async () => {
    const e = testEnv(),
      api = new FakeGitHub(),
      body = '/label add bug';
    api.comments = [
      {
        id: 99,
        issue_number: 1,
        created_at: new Date().toISOString(),
        body,
        user: { login: 'alice', type: 'User' },
        issue_url: `https://api.github.com/repos/${repo}/issues/1`,
      },
    ];
    const job: Job = {
      id: 'command-label',
      repo,
      installation: 1,
      kind: 'command',
      number: 1,
      commentId: 99,
      actor: 'alice',
      bodyHash: await sha256(body),
      time: new Date().toISOString(),
    };
    await processJob(e, job, api);
    expect(api.pr.labels).toContainEqual({ name: 'bug' });
    api.pr.labels = [];
    await processJob(e, job, api);
    expect(api.pr.labels).toEqual([]);
  });
});
describe('native receipts and controls', () => {
  it('recovers a comment whose response was lost using only GitHub state', async () => {
    const { gh, api } = await fixture();
    api.failAfterComment = true;
    await expect(gh.comment(1, 'welcome', 'hello')).rejects.toThrow('Connection lost');
    await fresh(gh, api).comment(1, 'welcome', 'hello');
    expect(api.comments).toHaveLength(1);
  });
  it('ignores forged human markers and cross-PR records', async () => {
    const { gh, api } = await fixture();
    await gh.record(1, 'test', { value: 1 }, 'hello');
    const original = structuredClone(api.comments[0]);
    api.comments[0].user = { login: 'alice', type: 'User' };
    expect(await fresh(gh, api).getRecord(1, 'test')).toBeUndefined();
    api.comments = [{ ...original, issue_number: 2 }];
    expect(await gh.getRecord(2, 'test')).toBeUndefined();
  });
  it('dry-run produces logs but no GitHub records or writes', async () => {
    const { gh, api } = await fixture('', { DRY_RUN: 'true' });
    const spy = vi.spyOn(console, 'log');
    await gh.record(1, 'plan', { value: 1 }, 'plan');
    expect(api.writes()).toHaveLength(0);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('dry_run'))).toBe(true);
    spy.mockRestore();
    gh.env.DRY_RUN = 'false';
    await gh.record(1, 'plan', { value: 1 }, 'plan');
    expect(api.comments).toHaveLength(1);
  });
  it('global and case-insensitive repository stops block writes independently', async () => {
    const { gh, api } = await fixture();
    gh.env.STOPPED_REPOSITORIES = repo.toLowerCase();
    await expect(gh.comment(1, 'test', 'hello')).rejects.toThrow('disabled');
    gh.env.STOPPED_REPOSITORIES = 'org/other';
    await gh.comment(1, 'test', 'hello');
    gh.env.EMERGENCY_STOP = 'true';
    await expect(gh.record(1, 'new', {}, 'new')).rejects.toThrow('disabled');
    expect(api.comments).toHaveLength(1);
  });
  it('handles public repository contributors and requests a permitted reviewer', async () => {
    const { env, api } = await fixture();
    api.pr.user = { login: 'contributor', type: 'User' };
    api.reviews = [];
    api.permissions.reviewer = 'write';
    api.config = 'enabled: true\ndryRun: false\nreviewers:\n  pool: [reviewer]\n  count: 1';
    const job: Job = {
      id: 'public-pr',
      repo,
      installation: 1,
      kind: 'reconcile',
      number: 1,
      time: new Date().toISOString(),
    };
    expect(await processJob(env, job, api)).toBe('ack');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'reviewer' }]);
    expect(api.pr.body).toContain('### Piper Progress');
    expect(api.calls.some((c) => c.route.endsWith('/collaborators') || c.route.endsWith('/subscribers'))).toBe(false);
  });
  it('blocks further writes when the repository is removed from the allowlist', async () => {
    const { gh, api } = await fixture('');
    await gh.comment(1, 'first', 'hello');
    gh.env.ALLOWED_REPOSITORIES = 'org/other';
    await expect(fresh(gh, api).comment(1, 'second', 'hello')).rejects.toThrow('disabled');
    expect(api.comments).toHaveLength(1);
  });
  it('admin status authenticates and obsolete database mutation routes are gone', async () => {
    const e = testEnv(),
      headers = { authorization: `Bearer ${e.ADMIN_TOKEN}` };
    expect((await app.request('/admin/status', {}, e)).status).toBe(401);
    const response = await app.request('/admin/status', { headers }, e);
    expect(await response.json()).toMatchObject({ database: false });
    expect((await app.request('/admin/stop', { method: 'POST', headers }, e)).status).toBe(404);
    expect((await app.request('/admin/retry/job', { method: 'POST', headers }, e)).status).toBe(404);
  });
  it('welcomes first issues once and leaves PR messages to their maintained comments', async () => {
    const { gh, api } = await fixture();
    await welcome(gh, 1, api.pr.user, 'issue');
    await welcome(fresh(gh, api), 1, api.pr.user, 'issue');
    api.pr.merged = true;
    api.pr.merged_at = new Date().toISOString();
    await welcome(gh, 1, api.pr.user, 'merged');
    expect(api.comments).toHaveLength(1);
    api.issueHistory = [{ number: 1 }];
    await welcome(gh, 2, api.pr.user, 'issue');
    await welcome(gh, 3, { login: 'bot', type: 'Bot' }, 'issue');
    expect(api.comments).toHaveLength(1);
  });
});
describe('timeline based reviewer lifecycle', () => {
  it('requests, reminds at 24h and rotates at 48h across cold starts', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [alice,bob,carol]\n  count: 1');
    api.reviews = [];
    await assign(gh, api.pr);
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
    api.timeline[0].created_at = new Date(Date.now() - 25 * 3600000).toISOString();
    await rotate(fresh(gh, api), api.pr);
    const count = api.comments.length;
    await rotate(fresh(gh, api), api.pr);
    expect(api.comments).toHaveLength(count);
    api.timeline[0].created_at = new Date(Date.now() - 49 * 3600000).toISOString();
    await rotate(fresh(gh, api), api.pr);
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
  });
  it('review responses stop reminders; missing timeline never invents an age', async () => {
    const { gh, api } = await fixture();
    api.pr.requested_reviewers = [{ login: 'bob' }];
    await rotate(gh, api.pr);
    expect(api.comments).toHaveLength(0);
    api.timeline = [
      {
        id: 1,
        event: 'review_requested',
        requested_reviewer: { login: 'bob' },
        created_at: new Date(Date.now() - 49 * 3600000).toISOString(),
      },
    ];
    api.reviews[0].state = 'CHANGES_REQUESTED';
    await rotate(gh, api.pr);
    expect(api.comments).toHaveLength(0);
  });
});
describe('native release objects', () => {
  it.each([repo, 'org/project'])(
    'prepares once, requires approval, waits for exact deployment and publishes once across cold starts in %s',
    async (repository) => {
      const { gh: configured, api } = await fixture('release:\n  enabled: true', { ALLOWED_REPOSITORIES: repository });
      const gh = new GitHub(configured.env, repository, configured.job, api);
      gh.config = configured.config;
      gh.commandOrder = configured.commandOrder;
      api.pr.head.repo = { full_name: repository };
      api.pr.base.repo = { full_name: repository };
      const date = new Date('2026-10-15T10:00:00Z');
      const row = (await prepareRelease(gh, date))!;
      await prepareRelease(fresh(gh, api), date);
      expect(row).toMatchObject({ repo: repository, state: 'awaiting_approval' });
      expect(api.calls.filter((x) => x.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
      await expect(publishRelease(gh, 1, 'mallory')).rejects.toThrow('维护者权限');
      api.reviews = [];
      await expect(publishRelease(gh, 1, 'alice')).rejects.toThrow('人工审查者');
      api.reviews = [
        {
          id: 1,
          user: { login: 'bob', type: 'User' },
          state: 'APPROVED',
          commit_id: 'abc123',
          submitted_at: new Date().toISOString(),
        },
      ];
      await publishRelease(gh, 1, 'alice');
      expect(api.calls.find((x) => x.route.endsWith('/merge'))?.args.merge_method).toBe('merge');
      expect(api.tags.size).toBe(0);
      api.workflows = [
        {
          id: 10,
          head_sha: 'merge123',
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'failure',
          run_attempt: 1,
        },
      ];
      await syncRelease(fresh(gh, api), row);
      expect((await releaseFor(gh, api.pr))?.state).toBe('deployment_failed');
      expect(api.tags.size).toBe(0);
      api.workflows[0].conclusion = 'success';
      api.workflows[0].run_attempt = 2;
      await syncRelease(fresh(gh, api), row);
      await syncRelease(fresh(gh, api), row);
      expect(api.tags.get('v0.1.0')).toBe('merge123');
      expect(api.releases).toHaveLength(1);
      expect(api.releases[0].body).toContain('alice');
      expect(api.releases[0]).toMatchObject({ draft: false, prerelease: false, make_latest: 'true' });
      expect((await releaseFor(gh, api.pr))?.state).toBe('published');
      const [owner, name] = repository.split('/');
      for (const call of api.calls) expect(call.args).toMatchObject({ owner, repo: name });
    },
  );
  it.each(['', 'release:\n  enabled: false'])(
    'requires releases to be explicitly enabled with configuration %j',
    async (config) => {
      const { gh, api } = await fixture(config);
      await expect(prepareRelease(gh, new Date(), true)).rejects.toThrow('release.enabled');
      expect(api.writes()).toHaveLength(0);
    },
  );
  it.each(['allowlist', 'release.enabled'])(
    'blocks preparation, merge and publication after %s revocation',
    async (policy) => {
      const { gh, api } = await fixture('release:\n  enabled: true');
      const row = (await prepareRelease(gh, new Date(), true))!;
      if (policy === 'allowlist') gh.env.ALLOWED_REPOSITORIES = 'org/other';
      else gh.config!.release.enabled = false;
      const writes = api.writes().length;
      await expect(prepareRelease(fresh(gh, api), new Date(), true)).rejects.toThrow('仓库白名单和 release.enabled');
      await expect(publishRelease(fresh(gh, api), 1, 'alice')).rejects.toThrow('仓库白名单和 release.enabled');
      await expect(syncRelease(fresh(gh, api), row)).rejects.toThrow('仓库白名单和 release.enabled');
      expect(api.writes()).toHaveLength(writes);
    },
  );
});
