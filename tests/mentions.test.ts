import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github';
import { addressUser } from '../src/mentions';
import { notifyPR, reconcilePR, rotate, welcome } from '../src/pulls';
import { prepareRelease, publishRelease, syncRelease } from '../src/releases';
import { STATUS_MARKER, visibleComment } from '../src/records';
import { READY_MARKER } from '../src/status';
import { sha256, type Job } from '../src/types';
import { processJob } from '../src/worker';
import { fixture, repo, type FakeGitHub } from './fixtures';

const mentions = (body: string) => [...visibleComment(body).replace(/`[^`]*`/g, '').matchAll(/(?<![\w@])@([A-Za-z0-9][A-Za-z0-9-]*)/g)].map(m => m[1]);
const bots = (api: FakeGitHub) => api.comments.filter(c => c.user?.login === 'piper[bot]' && c.user?.type === 'Bot');
const cold = (gh: GitHub, api: FakeGitHub) => { const next = new GitHub(gh.env, gh.repo, gh.job, api); next.config = gh.config; return next; };
async function commandJob(api: FakeGitHub, body: string, actor = 'alice'): Promise<Job> {
  const id = 99;
  api.comments.push({ id, issue_number: 1, body, user: { login: actor, type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
  return { id: `command:${repo.toLowerCase()}:${id}`, repo, installation: 1, kind: 'command', number: 1, commentId: id, bodyHash: await sha256(body), actor, time: new Date().toISOString() };
}

describe('targeted mentions', () => {
  it('addresses the author in pending and ready notices while keeping reviewer lists quiet', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0\nlabels:\n  - name: area/test\n    files: ["src/**"]\n    reviewers: [bob, carol]');
    api.reviews = []; api.pr.requested_reviewers = [{ login: 'bob' }];
    await reconcilePR(gh, 1); await notifyPR(gh, 1);
    const status = bots(api).find(c => c.body.startsWith(STATUS_MARKER))!;
    const notice = bots(api).find(c => c.body.startsWith(READY_MARKER))!;
    expect(status.body).toContain('[bob](https://github.com/bob)');
    expect(status.body).toContain('[carol](https://github.com/carol)');
    expect(mentions(status.body)).toEqual([]);
    expect(mentions(notice.body)).toEqual(['alice']);
    expect(notice.body).toContain('目前尚未满足');
    const writes = api.writes().length;
    await notifyPR(cold(gh, api), 1); expect(api.writes()).toHaveLength(writes);
    api.reviews = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: api.pr.head.sha, submitted_at: new Date().toISOString() }];
    await notifyPR(cold(gh, api), 1);
    expect(bots(api).filter(c => c.body.startsWith(READY_MARKER))).toHaveLength(1);
    expect(notice.body).toContain('已通过所有自动集成前检查');
    expect(mentions(notice.body)).toEqual(['alice']);
    const readyWrites = api.writes().length;
    await notifyPR(cold(gh, api), 1); expect(api.writes()).toHaveLength(readyWrites);
  });

  it.each(['/help', '/help contributor', '/summary Useful update', '/unknown', '/contributor add @outsider <outsider@example.com>'])('addresses the verified sender of %s once, including rejection and replay', async body => {
    const { env, api } = await fixture();
    const job = await commandJob(api, body);
    expect(await processJob(env, job, api)).toBe('ack');
    const reply = bots(api).find(c => !c.body.startsWith(STATUS_MARKER))!;
    expect(mentions(reply.body)).toEqual(['alice']);
    if (body === '/help') expect(reply.body).toContain('`/help contributor`');
    if (body === '/help contributor') expect(reply.body).toContain('/contributor add @login');
    expect(reply.body).not.toContain('@outsider');
    const writes = api.writes().length;
    expect(await processJob(env, job, api)).toBe('ack');
    expect(api.writes()).toHaveLength(writes);
    expect(bots(api)).toHaveLength(2);
  });

  it.each(['alice', 'carol'])('preserves the author and %s as recipients when rebuilding a merged command result', async actor => {
    const { env, api } = await fixture();
    const job = await commandJob(api, '/integrate', actor);
    expect(await processJob(env, job, api)).toBe('ack');
    expect(api.pr.merged).toBe(true);
    const refresh: Job = { ...job, id: 'merged-notice', kind: 'notice' };
    expect(await processJob(env, refresh, api)).toBe('ack');
    const results = bots(api).filter(c => visibleComment(c.body).includes('你的 PR 已合并'));
    expect(results).toHaveLength(1);
    expect(mentions(results[0].body)).toEqual(actor === 'alice' ? ['alice'] : ['carol', 'alice']);
    expect(results[0].body.match(/!\[庆祝合并\]/g)).toHaveLength(1);
    expect(results[0].body).toContain('🎉');
    expect(results[0].body).toContain('/assets/neurobounce.gif');
    const writes = api.writes().length;
    expect(await processJob(env, refresh, api)).toBe('ack'); expect(api.writes()).toHaveLength(writes);
  });

  it.each([{ login: 'outsider', type: 'User' }, { login: 'piper[bot]', type: 'Bot' }])('notifies human authors and keeps bot authors quiet: $login', async user => {
    const { gh, api } = await fixture(''); api.pr.user = user;
    await notifyPR(gh, 1);
    const notice = bots(api).find(c => c.body.startsWith(READY_MARKER))!;
    expect(mentions(notice.body)).toEqual(user.type === 'User' ? ['outsider'] : []);
    if (user.type === 'Bot') expect(notice.body).toContain('https://github.com/');
  });

  it('does not prefix the same recipient twice when GitHub username casing differs', async () => {
    expect(addressUser({ login: 'Alice', type: 'User' }, '@alice\n\nDone')).toBe('@alice\n\nDone');
  });

  it('welcomes an issue author once while escaping names embedded in configured prose', async () => {
    const { gh, api } = await fixture('welcome:\n  issue: "Hello @outsider"');
    await welcome(gh, 2, api.pr.user, 'issue'); await welcome(cold(gh, api), 2, api.pr.user, 'issue');
    expect(bots(api)).toHaveLength(1);
    expect(mentions(bots(api)[0].body)).toEqual(['alice']);
    expect(bots(api)[0].body).toContain('@\u200boutsider');
  });

  it.each([25, 49])('deduplicates the targeted review reminder at %i hours', async hours => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob]'); api.reviews = [];
    api.pr.requested_reviewers = [{ login: 'bob' }];
    api.timeline = [{ id: 7, event: 'review_requested', requested_reviewer: { login: 'bob' }, created_at: new Date(Date.now() - hours * 3600000).toISOString() }];
    await rotate(gh, api.pr); await rotate(cold(gh, api), api.pr);
    const reminders = bots(api).filter(c => c.body.includes(hours === 25 ? '审查请求已等待' : '没有可用替补'));
    expect(reminders).toHaveLength(1); expect(mentions(reminders[0].body)).toEqual(['bob']);
  });

  it('addresses the publishing maintainer in deployment failures and recovered results of a Bot-authored PR', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true');
    const row = (await prepareRelease(gh, new Date('2026-10-15T10:00:00Z')))!;
    await publishRelease(gh, 1, 'carol');
    api.workflows = [{ id: 10, head_sha: 'merge123', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', run_attempt: 1 }];
    api.workflowJobs[0].conclusion = 'failure';
    await syncRelease(cold(gh, api), row); await syncRelease(cold(gh, api), row);
    const failures = bots(api).filter(c => c.body.includes('发布部署未成功'));
    expect(failures).toHaveLength(1); expect(mentions(failures[0].body)).toEqual(['carol']);
    await notifyPR(cold(gh, api), 1); await notifyPR(cold(gh, api), 1);
    const results = bots(api).filter(c => c.body.includes('你的 PR 已合并'));
    expect(results).toHaveLength(1); expect(mentions(results[0].body)).toEqual(['carol']);
    expect(api.tags.size).toBe(0); expect(api.releases).toHaveLength(0);
  });
});
