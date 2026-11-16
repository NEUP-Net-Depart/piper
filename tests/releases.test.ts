import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github';
import { prepareRelease, publishRelease, releaseFor, requestRelease, syncRelease } from '../src/releases';
import { RELEASE_DELAY_MS, releaseGate, releasePlan } from '../src/release-policy';
import { notesFor } from '../src/release-notes';
import { integrate, reconcilePR } from '../src/pulls';
import { devSuccess, releaseFixture, repo, type FakeGitHub } from './fixtures';

const cold = (gh: GitHub, api: FakeGitHub, job = gh.job) => {
  const current = new GitHub(gh.env, gh.repo, job, api);
  current.config = gh.config;
  current.actor = gh.actor;
  return current;
};
const prepare = (gh: GitHub) => prepareRelease(gh, new Date(), true);
const mergeCalls = (api: FakeGitHub) => api.calls.filter((c) => c.route.endsWith('/merge'));
afterEach(() => vi.useRealTimers());

describe('on-demand release policy', () => {
  it('uses the existing Piper client while keeping ordinary integration behind its review and target gates', async () => {
    const { gh, api } = await releaseFixture();
    api.reviews = [];
    expect(await integrate(gh, 1, 'alice', api.pr.head.sha)).toBe(false);
    expect(gh.commandResult).toContain('人工审查者');
    await prepare(gh);
    expect(await integrate(gh, 1, 'carol', api.pr.head.sha)).toBe(false);
    expect(gh.commandResult).toContain('发布目标分支必须使用发布流程');
    expect(api.calls.some((c) => c.route.endsWith('/merge-async') || c.route.endsWith('/merge'))).toBe(false);
    await publishRelease(gh, 1, 'carol');
    expect(api.calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
    expect(mergeCalls(api)).toHaveLength(1);
    expect(api.calls.some((c) => c.route.endsWith('/installation'))).toBe(false);
  });
  it('never creates a release from a cron preparation and restricts explicit preparation to maintain/admin', async () => {
    const { gh, api } = await releaseFixture();
    expect(await prepareRelease(gh, new Date())).toBeNull();
    gh.actor = 'alice';
    await expect(prepare(gh)).rejects.toThrow('maintain / admin');
    gh.actor = 'carol';
    const row = (await prepare(gh))!;
    expect(row.state).toBe('waiting');
    expect(api.pr.draft).toBe(false);
    expect(api.pr.body).toContain('@alice');
    expect(api.calls.find((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')?.args.draft).toBe(false);
    expect(Date.parse(row.mergeAfter)).toBe(Date.parse(api.pr.created_at!) + RELEASE_DELAY_MS);
  });
  it('merges after two hours with no approvals, exact title, and no Piper tag/release writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T16:00:00Z'));
    const { gh, api } = await releaseFixture();
    api.reviews = [];
    const row = (await prepare(gh))!;
    await syncRelease(cold(gh, api), row);
    expect(mergeCalls(api)).toHaveLength(0);
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    await syncRelease(cold(gh, api), row);
    await syncRelease(cold(gh, api), row);
    expect(mergeCalls(api)).toHaveLength(1);
    expect(mergeCalls(api)[0]!.args).toMatchObject({
      sha: 'abc123',
      merge_method: 'merge',
      commit_title: '[release] 2026年11月16日版本发布',
      commit_message: '',
      headers: { 'x-github-api-version': '2022-11-28' },
    });
    expect(api.tags.size).toBe(0);
    expect(api.releases).toEqual([]);
  });
  it('updates an existing release and contributors without resetting its deadline', async () => {
    const { gh, api } = await releaseFixture();
    const row = (await prepare(gh))!;
    api.pr.head.sha = 'new-head';
    const again = (await prepare(cold(gh, api, 'second-request')))!;
    expect(again.mergeAfter).toBe(row.mergeAfter);
    expect(api.calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
    expect(api.pr.body).toContain('...new-head');
    expect((await releaseGate(gh, api.pr, false)).ready).toBe(false);
    devSuccess(api);
    expect((await releaseGate(gh, api.pr, false)).ready).toBe(true);
  });
  it.each([
    'running',
    'failure',
    'skipped',
    'missing',
    'old-sha',
    'pr-event',
    'wrong-branch',
    'wrong-app',
    'wrong-suite',
    'new-attempt',
  ])('waits for trustworthy current dev verification: %s', async (mode) => {
    const { gh, api } = await releaseFixture();
    await prepare(gh);
    if (mode === 'running') api.workflows[0].status = 'in_progress';
    if (mode === 'failure') api.workflows[0].conclusion = 'failure';
    if (mode === 'skipped') api.workflowJobs[0].conclusion = 'skipped';
    if (mode === 'missing') api.workflowJobs.pop();
    if (mode === 'old-sha') api.pr.head.sha = 'new-sha';
    if (mode === 'pr-event') api.workflows[0].event = 'pull_request';
    if (mode === 'wrong-branch') api.workflows[0].head_branch = 'feature';
    if (mode === 'wrong-suite') api.workflows[0].check_suite_id = 999;
    if (mode === 'wrong-app') gh.config!.merge.trustedCheckAppIds = [999];
    if (mode === 'new-attempt') api.workflows.push({ ...api.workflows[0], id: 11, conclusion: 'failure' });
    await expect(publishRelease(gh, 1, 'carol')).rejects.toThrow('发布尚未满足');
    expect(mergeCalls(api)).toHaveLength(0);
  });
  it('ignores skipped PR checks and uses the latest dev push attempt', async () => {
    const { gh, api } = await releaseFixture();
    await prepare(gh);
    api.runs = [{ name: 'test', conclusion: 'skipped' }];
    api.workflows.push({ ...api.workflows[0], id: 200, event: 'pull_request', conclusion: 'success' });
    api.workflows[0].run_attempt = 3;
    await publishRelease(gh, 1, 'carol');
    expect(mergeCalls(api)).toHaveLength(1);
    expect(api.calls.filter((c) => c.route.includes('/attempts/')).every((c) => c.args.attempt_number === 3)).toBe(
      true,
    );
  });
  it.each(['close', 'unlabel', 'close-reopen', 'remove-readd'])('cancels persistently after %s', async (mode) => {
    const { gh, api } = await releaseFixture();
    const row = (await prepare(gh))!;
    if (mode === 'close') api.pr.state = 'closed';
    if (mode === 'unlabel') api.pr.labels = [];
    if (mode === 'close-reopen') api.timeline = [{ event: 'closed' }, { event: 'reopened' }];
    if (mode === 'remove-readd') api.timeline = [{ event: 'unlabeled', label: { name: 'auto-release' } }];
    expect((await releaseFor(gh, api.pr))!.state).toBe('cancelled');
    api.pr.state = 'open';
    api.pr.labels = [{ name: 'auto-release' }];
    api.timeline = [];
    await prepare(cold(gh, api, 'another-request'));
    await syncRelease(cold(gh, api), row);
    await expect(publishRelease(gh, 1, 'carol')).rejects.toThrow('已取消');
    expect(mergeCalls(api)).toHaveLength(0);
  });
  it('does not accept a forged marker or a changed head/base as release identity', async () => {
    const { gh, api } = await releaseFixture();
    api.pr.body = '<!-- piper-release:v2 -->';
    api.pr.head.ref = 'dev';
    api.pr.base.ref = 'main';
    expect(await releasePlan(gh, api.pr)).toBeUndefined();
    await expect(prepare(gh)).rejects.toThrow('拒绝');
    api.pr.user = { login: gh.env.BOT_LOGIN, type: 'Bot' };
    expect((await releaseGate(gh, api.pr, false)).ready).toBe(false);
    await prepare(gh);
    api.pr.head.ref = 'feature';
    expect(await releasePlan(gh, api.pr)).toBeUndefined();
  });
  it('never requests reviewers for a trusted release but keeps ordinary PR policy intact', async () => {
    const { gh, api } = await releaseFixture();
    gh.config!.reviewers = { pool: ['bob'], count: 1, remindHours: 24, rotateHours: 48 };
    await prepare(gh);
    api.reviews = [];
    await reconcilePR(gh, 1, true);
    expect(api.pr.requested_reviewers).toEqual([]);
    expect(api.pr.body).not.toContain('审查详情');
  });
  it.each(['dirty', 'unknown', 'behind'])('postpones merge for %s', async (state) => {
    const { gh, api } = await releaseFixture();
    await prepare(gh);
    api.pr.mergeable_state = state;
    await expect(publishRelease(gh, 1, 'carol')).rejects.toThrow('合并检查');
    expect(mergeCalls(api)).toHaveLength(0);
  });
  it('rechecks head and cancellation just before merge', async () => {
    const { gh, api } = await releaseFixture();
    await prepare(gh);
    let reads = 0;
    api.extra = async (route) => {
      if (route.endsWith('/attempts/{attempt_number}/jobs') && ++reads === 1) api.pr.labels = [];
      return undefined;
    };
    await expect(publishRelease(gh, 1, 'carol')).rejects.toThrow('已取消');
    expect(mergeCalls(api)).toHaveLength(0);
  });
  it.each([
    'POST /repos/{owner}/{repo}/pulls',
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
    'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
  ])('recovers a lost response for %s across restarts', async (route) => {
    const { gh, api } = await releaseFixture();
    const request = api.request.bind(api);
    let lost = false;
    api.request = async (r, args) => {
      const result = await request(r, args);
      if (!lost && r === route) {
        lost = true;
        throw new Error('Response lost');
      }
      return result;
    };
    if (route.endsWith('/merge')) {
      await prepare(gh);
      await expect(publishRelease(gh, 1, 'carol')).rejects.toThrow('Response lost');
      await publishRelease(cold(gh, api), 1, 'carol');
      expect(mergeCalls(api)).toHaveLength(1);
    } else {
      await expect(prepare(gh)).rejects.toThrow('Response lost');
      await prepare(cold(gh, api));
      expect((await releaseFor(gh, api.pr))!.state).toBe('waiting');
      expect(api.pr.labels).toContainEqual({ name: 'auto-release' });
    }
    expect(api.calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
  });
  it('does not recreate a merged release when a reused request is delivered again', async () => {
    const { gh, api } = await releaseFixture();
    await prepare(gh);
    const reused = cold(gh, api, 'second-request');
    await prepare(reused);
    await publishRelease(gh, 1, 'carol');
    await prepare(cold(reused, api));
    expect(api.calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
  });
});

describe('release workflow authentication', () => {
  it.each(['success', 'actor', 'rerunner', 'branch', 'event', 'path', 'fork', 'failed'])(
    'validates %s',
    async (mode) => {
      const { gh, api } = await releaseFixture();
      const run = {
        id: 15,
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        path: '.github/workflows/release.yml',
        head_branch: 'main',
        created_at: new Date().toISOString(),
        repository: { full_name: repo },
        head_repository: { full_name: repo },
        actor: { login: 'carol', type: 'User' },
        triggering_actor: { login: 'carol', type: 'User' },
      };
      if (mode === 'actor') run.actor.login = 'alice';
      if (mode === 'rerunner') run.triggering_actor.login = 'alice';
      if (mode === 'branch') run.head_branch = 'feature';
      if (mode === 'event') run.event = 'push';
      if (mode === 'path') run.path = '.github/workflows/check.yml';
      if (mode === 'fork') run.head_repository.full_name = 'other/repo';
      if (mode === 'failed') run.conclusion = 'failure';
      api.extra = async (route) => (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}' ? run : undefined);
      if (mode === 'success') expect((await requestRelease(gh, 15))?.state).toBe('waiting');
      else {
        await expect(requestRelease(gh, 15)).rejects.toThrow(mode === 'failed' ? '未成功' : '维护者 workflow_dispatch');
        expect(api.writes()).toHaveLength(0);
      }
    },
  );
});

it('collects merged PR authors, commit authors and coauthors, deduplicates and excludes bots', async () => {
  const { gh, api } = await releaseFixture();
  api.extra = async (route, args) => {
    if (route === 'POST /graphql')
      return {
        data: {
          repository: {
            object: {
              authors: {
                nodes: [
                  {
                    name: 'Hidden Email',
                    email: 'hidden@private.test',
                    user: { login: 'private-contributor', __typename: 'User' },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      };
    if (route.includes('/compare/'))
      return {
        commits: [
          {
            sha: 'a',
            author: { login: 'Alice', type: 'User' },
            commit: {
              author: { name: 'Alice', email: 'a@example.test' },
              message:
                'fix\n\nCo-authored-by: Alias <a@example.test>\nCo-authored-by: Carol <123+carol@users.noreply.github.com>\nCo-authored-by: Unknown <unknown@private.test>\nCo-authored-by: Bot <bot@users.noreply.github.com>',
            },
          },
        ],
      };
    if (route.endsWith('/commits/{commit_sha}/pulls'))
      return [
        {
          number: 3,
          title: 'Fix appointments',
          merged_at: 'now',
          user: { login: 'Bob', type: 'User' },
          base: { ref: 'dev', repo: { full_name: repo } },
        },
        {
          number: 4,
          title: 'Dependencies',
          merged_at: 'now',
          user: { login: 'dependabot[bot]', type: 'Bot' },
          base: { ref: 'dev', repo: { full_name: repo } },
        },
      ];
    if (route === 'GET /users/{username}')
      return { id: 123, login: args.username, type: args.username === 'bot' ? 'Bot' : 'User' };
    if (route === 'GET /search/users') return { items: [], total_count: 0 };
    return undefined;
  };
  const notes = await notesFor(gh, 'base', 'head');
  expect(notes).toContain('#3');
  expect(notes).toContain('@Bob');
  expect(notes).toContain('@carol');
  expect(notes).toContain('@private-contributor');
  expect(notes.match(/@Alice/g)).toHaveLength(1);
  expect(notes).toContain('Unknown');
  expect(notes).not.toContain('@bot');
  expect(notes).not.toContain('@dependabot');
  expect(notes).not.toContain('private.test');
});

it('reuses unchanged release notes on periodic checks but rebuilds them after a new commit', async () => {
  const { gh, api } = await releaseFixture();
  const row = (await prepare(gh))!;
  const count = () => api.calls.filter((c) => c.route === 'POST /graphql').length;
  const initial = count();
  await syncRelease(cold(gh, api), row);
  expect(count()).toBe(initial);
  api.pr.head.sha = 'new-head';
  await syncRelease(cold(gh, api), row);
  expect(count()).toBeGreaterThan(initial);
});

it('rejects a forged authorization even if someone edits a Piper-owned recovery comment', async () => {
  const { encodeRecord } = await import('../src/records');
  const { gh, api } = await releaseFixture();
  await prepare(gh);
  const plan = (await releasePlan(gh, api.pr))!;
  const original = encodeRecord(gh.repo, 1, 'release:v2', plan);
  const comment = api.comments.find((c) => c.body.includes(original));
  comment.body = comment.body.replace(original, encodeRecord(gh.repo, 1, 'release:v2', { ...plan, request: 'forged' }));
  await expect(publishRelease(cold(gh, api), 1, 'carol')).rejects.toThrow('签名无效');
  expect(mergeCalls(api)).toHaveLength(0);
});

it('does not recreate a PR closed after GitHub created it but before Piper received the response', async () => {
  const { gh, api } = await releaseFixture();
  const request = api.request.bind(api);
  let lost = false;
  api.request = async (route, args) => {
    const result = await request(route, args);
    if (!lost && route === 'POST /repos/{owner}/{repo}/pulls') {
      lost = true;
      api.pr.state = 'closed';
      throw new Error('Response lost');
    }
    return result;
  };
  await expect(prepare(gh)).rejects.toThrow('Response lost');
  expect(await prepare(cold(gh, api))).toBeNull();
  expect(api.calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls')).toHaveLength(1);
});

it('keeps closed history inert across a webhook secret rotation', async () => {
  const { gh, api } = await releaseFixture();
  await prepare(gh);
  api.pr.state = 'closed';
  gh.env.WEBHOOK_SECRET = 'rotated-secret';
  expect(await releasePlan(cold(gh, api), api.pr)).toBeUndefined();
  expect(await prepare(cold(gh, api))).toBeNull();
  api.pr.state = 'open';
  await expect(publishRelease(cold(gh, api), 1, 'carol')).rejects.toThrow('签名无效');
});
