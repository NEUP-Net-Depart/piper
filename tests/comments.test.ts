import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github';
import { commentBody, decodeRecords, encodeRecord, prState, STATUS_MARKER, visibleComment } from '../src/records';
import { processJob } from '../src/worker';
import { sha256, type Job } from '../src/types';
import { fixture, repo } from './fixtures';

const bots = (api: { comments: any[] }) => api.comments.filter(c => c.user?.login === 'piper[bot]' && c.user?.type === 'Bot');
async function jobFor(api: { comments: any[] }, id: number, body: string): Promise<Job> {
  api.comments.push({ id, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
  return { id: 'command:' + repo.toLowerCase() + ':' + id, repo, installation: 1, kind: 'command', number: 1, commentId: id, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
}

describe('compact collaboration comments', () => {
  it('creates the status first and keeps welcome and automatic assignment records inside it', async () => {
    const { env, api, gh } = await fixture(); api.reviews = [];
    api.config = 'enabled: true\ndryRun: false\nreviewers:\n  pool: [bob]\n  count: 1';
    const job: Job = { id: 'opened', repo, installation: 1, kind: 'reconcile', number: 1, time: new Date().toISOString() };
    expect(await processJob(env, job, api)).toBe('ack');
    expect(bots(api)).toHaveLength(2);
    const main = bots(api)[0]; expect(api.comments[0].id).toBe(main.id);
    expect(main.body.startsWith(STATUS_MARKER)).toBe(true);
    expect(main.body).toContain(gh.config!.welcome.pr);
    expect((await gh.records(1)).map(r => r.key)).toContain('review-plan:opened');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
    expect(await processJob(env, job, api)).toBe('ack'); expect(bots(api)).toHaveLength(2);
  });

  it('keeps plans in the status and creates one final result with its completion receipt', async () => {
    const { env, api, gh } = await fixture(); api.runs[0].status = 'in_progress';
    const job = await jobFor(api, 99, '/integrate auto');
    expect(await processJob(env, job, api)).toBe('ack');
    expect(bots(api)).toHaveLength(2); expect(bots(api)[0].body.startsWith(STATUS_MARKER)).toBe(true);
    const reply = bots(api)[1];
    const keys = decodeRecords(reply, env.BOT_LOGIN, repo, 1).map(r => r.key);
    expect(keys).toEqual(['command-done:' + job.id]);
    const statusKeys = decodeRecords(bots(api)[0], env.BOT_LOGIN, repo, 1).map(r => r.key);
    for (const prefix of ['command-head:', 'command-state:']) expect(statusKeys).toContain(prefix + job.id);
    expect(visibleComment(reply.body)).toContain('条件满足后自动集成');
    expect(visibleComment(reply.body)).not.toMatch(/已记录|已处理/);
    const refresh = (env.TASKS.send as any).mock.calls.at(-1)[0];
    await processJob(env, refresh, api);
    expect((await prState(gh, api.pr)).integrate_head).toBe('abc123');
    const writes = api.writes().length;
    expect(await processJob(env, job, api)).toBe('ack'); expect(api.writes()).toHaveLength(writes);
    expect(bots(api)).toHaveLength(3); expect(bots(api)[1].id).toBe(reply.id);
    expect((await gh.records(1)).filter(r => r.key.endsWith(job.id))).toHaveLength(3);
  });

  it.each(['/summary A useful change', '/author Alice <alice@example.com>', '/contributor add Bob <bob@example.com>', '/help', '/label add bug'])('returns one final reply for %s', async body => {
    const { env, api, gh } = await fixture(); const job = await jobFor(api, 99, body);
    expect(await processJob(env, job, api)).toBe('ack');
    expect(bots(api)).toHaveLength(2);
    const reply = bots(api)[1];
    expect(decodeRecords(reply, env.BOT_LOGIN, repo, 1).some(r => r.key === 'command-done:' + job.id)).toBe(true);
    expect(visibleComment(reply.body)).not.toMatch(/已记录|已处理/);
    const persisted = await gh.records(1);
    expect(await processJob(env, job, api)).toBe('ack');
    expect(bots(api)).toHaveLength(2); expect(await gh.records(1)).toEqual(persisted);
  });

  it('updates the existing reply on rejection after a pinned head, keeping the recovery record', async () => {
    const { env, api } = await fixture();
    api.pr.head.sha = 'later';
    const job = await jobFor(api, 99, '/integrate');
    const staged = new GitHub(env, repo, job.id, api); staged.config = (await fixture()).gh.config; staged.commandName = 'integrate';
    await staged.ensureStatus(1); await staged.record(1, 'command-head:' + job.id, { head: 'abc123' });
    expect(await processJob(env, job, api)).toBe('ack');
    expect(bots(api)).toHaveLength(2); expect(visibleComment(bots(api)[1].body)).toContain('请求未完成');
    const records = decodeRecords(bots(api)[0], env.BOT_LOGIN, repo, 1);
    expect(records.find(r => r.key === 'command-head:' + job.id)?.value).toEqual({ head: 'abc123' });
    expect(records.some(r => r.key.startsWith('command-done:'))).toBe(false);
    expect(api.pr.merged).toBe(false);
  });

  it('recovers a lost final edit without reapplying a command after a later human change', async () => {
    const { env, api, gh } = await fixture();
    const job = await jobFor(api, 99, '/summary Updated summary');
    const request = api.request.bind(api); let lost = false;
    api.request = async (route, args) => {
      const response = await request(route, args);
      if (!lost && !route.startsWith('GET ') && decodeRecords({ ...response.data, body: args?.body }, env.BOT_LOGIN, repo, 1).some(r => r.key === 'command-done:' + job.id)) { lost = true; throw new Error('Lost completion response'); }
      return response;
    };
    expect(await processJob(env, job, api)).toBe('retry');
    expect(bots(api)).toHaveLength(2);
    const writes = api.writes().length;
    expect(await processJob(env, job, api)).toBe('ack'); expect(api.writes()).toHaveLength(writes);
    expect((await prState(gh, api.pr)).metadata.summary).toBe('Updated summary');
  });
});

describe('embedded recovery records', () => {
  it('reads legacy and multiple records, validating Bot identity and repository for every entry', async () => {
    const { gh, api } = await fixture();
    const records = [encodeRecord(repo, 1, 'first', 1), encodeRecord(repo, 1, 'second', 2), encodeRecord('other/repo', 1, 'foreign', 3)];
    const c = { id: 1, issue_number: 1, created_at: new Date().toISOString(), user: { login: 'piper[bot]', type: 'Bot' }, body: commentBody(STATUS_MARKER + '\nStatus', records) };
    api.comments.push(c);
    expect((await gh.records(1)).map(r => r.key)).toEqual(['first', 'second']);
    expect(decodeRecords({ ...c, body: 'Legacy reply\n\n' + records[0] }, 'piper[bot]', repo, 1)).toHaveLength(1);
    expect(decodeRecords({ ...c, user: { login: 'piper[bot]', type: 'User' } }, 'piper[bot]', repo, 1)).toEqual([]);
    expect(decodeRecords(c, 'piper[bot]', repo, 2)).toEqual([]);
  });

  it('preserves hidden records during visible updates and refuses an oversized update', async () => {
    const { gh, api } = await fixture();
    await gh.record(1, 'first', { persisted: true }); const id = bots(api)[0].id;
    await gh.managedComment(1, STATUS_MARKER, 'Updated status');
    expect(await gh.getRecord(1, 'first')).toEqual({ persisted: true });
    const body = bots(api)[0].body;
    await expect(gh.managedComment(1, STATUS_MARKER, 'x'.repeat(60000))).rejects.toThrow('storage limit');
    expect(bots(api)[0].body).toBe(body); expect(bots(api)[0].id).toBe(id);
  });

  it('refuses to erase malformed hidden data during a status update', async () => {
    const { gh, api } = await fixture(); await gh.ensureStatus(1);
    bots(api)[0].body += '\n\n<!-- piper:data -->\n<!-- piper-record:v1:broken-value -->';
    const body = bots(api)[0].body;
    await expect(gh.managedComment(1, STATUS_MARKER, 'Updated status')).rejects.toThrow('Malformed Piper recovery record');
    expect(bots(api)[0].body).toBe(body);
  });

  it('retries when metadata changes during a visible update, then preserves the concurrent record', async () => {
    const { gh, api } = await fixture(); await gh.ensureStatus(1);
    let changed = false;
    api.extra = async (route, args) => {
      if (!changed && route === 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}') {
        changed = true; const c = api.comments.find(c => c.id === args.comment_id);
        c.body = commentBody(visibleComment(c.body), [encodeRecord(repo, 1, 'concurrent', { keep: true })]);
      }
      return undefined;
    };
    await expect(gh.managedComment(1, STATUS_MARKER, 'New status')).rejects.toThrow('changed during update');
    await gh.managedComment(1, STATUS_MARKER, 'New status');
    expect(await gh.getRecord(1, 'concurrent')).toEqual({ keep: true }); expect(bots(api)).toHaveLength(1);
  });
});
