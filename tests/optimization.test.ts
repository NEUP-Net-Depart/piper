import { describe, expect, it } from 'vitest';
import { gate, getPR, integrate } from '../src/pulls';
import { processJob, tick } from '../src/worker';
import { prState } from '../src/records';
import type { Job } from '../src/types';
import { fixture, repo } from './fixtures';

const task = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  repo,
  installation: 1,
  kind: 'reconcile',
  number: 1,
  time: '2026-10-17T08:00:00Z',
  ...extra,
});
const comments = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments';

describe('shared PR refresh and request cache', () => {
  it.each(['open', 'closed'] as const)(
    'does not rewrite an unchanged %s PR when Cron and webhooks use different repository casing',
    async (state) => {
      const { env, api } = await fixture();
      api.pr.state = state;
      api.pr.merged = state === 'closed';
      api.pr.merge_commit_sha = state === 'closed' ? 'merge123' : null;
      api.pr.body = 'Keep the author description.';
      expect(await processJob(env, task('cron', { repo: repo.toLowerCase() }), api)).toBe('ack');
      const body = api.pr.body,
        comments = structuredClone(api.comments);
      api.calls = [];
      for (const repository of [repo, repo.toUpperCase(), repo.toLowerCase()]) {
        expect(await processJob(env, task('webhook:' + repository, { repo: repository }), api)).toBe('ack');
        expect(api.pr.body).toBe(body);
        expect(api.comments).toEqual(comments);
      }
      expect(api.writes()).toHaveLength(0);
      expect(env.TASKS.send).not.toHaveBeenCalled();
    },
  );

  it('renders all views together and reads comments, files, reviews and checks once on an unchanged PR', async () => {
    const { env, api } = await fixture();
    expect(await processJob(env, task('initial'), api)).toBe('ack');
    expect(api.comments.map((c) => c.body).join('\n')).toContain('已满足 CI 和审查要求');
    api.calls = [];
    expect(await processJob(env, task('unchanged'), api)).toBe('ack');
    expect(api.writes()).toHaveLength(0);
    for (const path of [
      comments,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    ])
      expect(api.calls.filter((c) => c.route === path)).toHaveLength(1);
    expect(api.calls.length).toBeLessThanOrEqual(18);
    expect(env.TASKS.send).not.toHaveBeenCalled();
  });

  it('updates cached recovery records after writes and detects an intervening remote edit', async () => {
    const { gh, api } = await fixture();
    gh.useReadCache();
    await gh.record(1, 'first', { value: 1 });
    await gh.record(1, 'second', { value: 2 });
    expect((await gh.records(1)).map((r) => r.key)).toEqual(['first', 'second']);
    api.comments[0].body += '\nRemote edit';
    await expect(gh.record(1, 'third', 3)).rejects.toThrow('changed during update');
    expect(api.comments[0].body).toContain('Remote edit');
    expect(await gh.getRecord(1, 'third')).toBeUndefined();
  });

  it('bypasses warmed CI and review caches when integrating', async () => {
    const { gh, api } = await fixture();
    gh.useReadCache();
    expect((await gate(gh, await getPR(gh, 1))).ready).toBe(true);
    api.runs[0].conclusion = 'failure';
    api.reviews = [];
    expect(await integrate(gh, 1, 'alice', api.pr.head.sha)).toBe(false);
    expect(api.pr.merged).toBe(false);
    expect(gh.commandResult).toContain('CI 未成功');
    expect(gh.commandResult).toContain('0 位');
  });

  it('invalidates changed-file evidence after a new head, including a high risk rename', async () => {
    const { gh, api } = await fixture();
    gh.useReadCache();
    expect((await gate(gh, await getPR(gh, 1))).highRisk).toBe(false);
    api.pr.head.sha = 'newhead';
    api.files = [{ filename: 'docs/moved.md', previous_filename: 'migrations/secret.sql' }];
    const current = await getPR(gh, 1);
    expect((await gate(gh, current)).highRisk).toBe(true);
    expect((await prState(gh, current)).integrate_head).toBeNull();
  });
});

describe('targeted and compensating scans', () => {
  it('targets an unassociated CI event by SHA without refreshing unrelated open PRs', async () => {
    const { env, api } = await fixture();
    api.prs = [{ ...api.pr, number: 2, head: { ...api.pr.head, sha: 'unrelated' } }];
    expect(
      await processJob(
        env,
        task('ci', { kind: 'scan', number: undefined, head: api.pr.head.sha, syncOnly: true }),
        api,
      ),
    ).toBe('ack');
    const sent: Job[] = (env.TASKS.send as any).mock.calls.map((c: any[]) => c[0] as Job);
    expect(sent.map((j) => j.number)).toEqual([1]);
  });

  it('keeps fork PRs in a workflow scan and avoids release work for an unrelated workflow', async () => {
    const { env, api } = await fixture();
    api.config += 'release:\n  enabled: true';
    api.pr.head.repo = { full_name: 'someone/fork' };
    expect(
      await processJob(
        env,
        task('ci-fork', {
          kind: 'scan',
          number: undefined,
          head: api.pr.head.sha,
          branch: 'fork-branch',
          workflow: 'unrelated.yml',
          syncOnly: true,
        }),
        api,
      ),
    ).toBe('ack');
    expect((env.TASKS.send as any).mock.calls.map((c: any[]) => c[0].kind)).toEqual(['reconcile']);
  });

  it('does not treat a completed unrelated workflow as a base-branch push', async () => {
    const { env, api } = await fixture();
    await processJob(
      env,
      task('unrelated-workflow', {
        kind: 'scan',
        number: undefined,
        head: 'other',
        branch: 'dev',
        workflow: 'smoke.yml',
        syncOnly: true,
      }),
      api,
    );
    expect(env.TASKS.send).not.toHaveBeenCalled();
    await processJob(
      env,
      task('base-push', {
        kind: 'scan',
        number: undefined,
        head: 'other',
        branch: 'dev',
        baseChanged: true,
        syncOnly: true,
      }),
      api,
    );
    expect((env.TASKS.send as any).mock.calls[0][0]).toMatchObject({ kind: 'reconcile', number: 1 });
  });

  it('refreshes PRs on other bases when the trusted configuration changes', async () => {
    const { env, api } = await fixture();
    api.pr.base.ref = 'maintenance';
    await processJob(
      env,
      task('config-push', {
        kind: 'scan',
        number: undefined,
        head: 'other',
        branch: 'dev',
        baseChanged: true,
        configChanged: true,
        syncOnly: true,
      }),
      api,
    );
    expect((env.TASKS.send as any).mock.calls[0][0]).toMatchObject({ kind: 'reconcile', number: 1 });
  });

  it('syncs deployment completion without preparing another scheduled release', async () => {
    const { env, api } = await fixture();
    api.config += 'release:\n  enabled: true';
    expect(
      await processJob(
        env,
        task('deploy', {
          kind: 'scan',
          number: undefined,
          head: 'merge123',
          branch: 'main',
          workflow: 'ci.yml',
          syncOnly: true,
        }),
        api,
      ),
    ).toBe('ack');
    expect((env.TASKS.send as any).mock.calls.map((c: any[]) => c[0])).toContainEqual(
      expect.objectContaining({ kind: 'release', syncOnly: true }),
    );
  });

  it('uses an overlapping recent-closed window and retains daily and manual full recovery', async () => {
    const { env, api } = await fixture();
    await tick(env, new Date('2026-10-17T08:00:00Z'), api);
    await tick(env, new Date('2026-10-18T00:00:00Z'), api);
    const sent = (env.TASKS.send as any).mock.calls.map((c: any[]) => c[0]);
    expect(sent[0]).toMatchObject({ includeClosed: true, closedSince: '2026-10-17T07:00:00.000Z' });
    expect(sent[1]).toMatchObject({ includeClosed: true });
    expect(sent[1].closedSince).toBeUndefined();
    api.pr.state = 'closed';
    api.extra = async (route, args) =>
      route === 'GET /repos/{owner}/{repo}/pulls' && args.state === 'closed'
        ? [{ ...api.pr, updated_at: '2026-10-16T12:00:00Z' }]
        : undefined;
    (env.TASKS.send as any).mockClear();
    await processJob(env, { ...sent[0], id: 'recent' }, api);
    expect((env.TASKS.send as any).mock.calls.some((c: any[]) => c[0].kind === 'reconcile')).toBe(false);
    await processJob(env, { ...sent[1], id: 'manual', time: '2026-10-17T08:00:00Z' }, api);
    expect((env.TASKS.send as any).mock.calls.some((c: any[]) => c[0].kind === 'reconcile')).toBe(true);
  });
});
