import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github';
import { gate, getPR, reconcilePR } from '../src/pulls';
import { commentBody, encodeRecord, prState, recordMarkers, STATUS_MARKER, visibleComment } from '../src/records';
import { PROGRESS_END, PROGRESS_START, summarize } from '../src/status';
import { fixture, repo, type FakeGitHub } from './fixtures';

const pullRoute = '/repos/{owner}/{repo}/pulls/{pull_number}';
const edits = (api: FakeGitHub) => api.writes().filter(c => c.route === `PATCH ${pullRoute}`);
const cold = (gh: GitHub, api: FakeGitHub) => { const next = new GitHub(gh.env, gh.repo, 'retry', api); next.config = gh.config; return next; };

describe('progress in the PR description', () => {
  it.each([null, '', '## Changes\r\n\r\nKeep **formatting**, @alice and trailing spaces.  \r\n', '<!-- piper-release:v1:2026-10-18:v0.1.0:abc123 -->\nRelease notes'])('preserves the original description %j and expands the checklist', async original => {
    const { gh, api } = await fixture(); api.pr.body = original;
    await reconcilePR(gh, 1);
    expect(api.pr.body!.startsWith(`${original ?? ''}${original ? '\n\n' : ''}${PROGRESS_START}\n`)).toBe(true);
    expect(api.pr.body!.endsWith(PROGRESS_END)).toBe(true);
    const expanded = api.pr.body!.split('<details>')[0]!;
    expect(expanded).toContain('### Piper Progress');
    expect(expanded).toContain('- [x] CI');
    expect(expanded).toContain('- [x] 人工审查');
    expect(api.pr.body).not.toContain('piper-record:');
    expect(visibleComment(api.comments[0].body)).toBe(`${STATUS_MARKER}\n[查看 PR 描述中的协作进度](https://github.com/${repo}/pull/1#piper-progress)。`);
    const writes = api.writes().length;
    await reconcilePR(cold(gh, api), 1);
    expect(api.writes()).toHaveLength(writes);
    expect(api.pr.body!.split(PROGRESS_START)).toHaveLength(2);
  });

  it('migrates the legacy status comment while preserving command and recovery records', async () => {
    const { gh, api } = await fixture();
    const record = encodeRecord(repo, 1, 'command-state:summary', { order: 1, actor: 'alice', head: 'abc123', change: { kind: 'summary', value: 'Keep this summary' } });
    api.comments.push({ id: 42, issue_number: 1, user: { login: gh.env.BOT_LOGIN, type: 'Bot' }, body: commentBody(`${STATUS_MARKER}\n### Piper 协作状态\n\n- [ ] Old progress`, [record]) });
    await reconcilePR(gh, 1);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0].id).toBe(42);
    expect(recordMarkers(api.comments[0].body)).toContain(record);
    expect(visibleComment(api.comments[0].body)).not.toContain('- [');
    expect(api.pr.body).toContain('Keep this summary');
    expect((await prState(cold(gh, api), api.pr)).metadata.summary).toBe('Keep this summary');
  });

  it('retains author edits before and after the section and moves progress back to the bottom', async () => {
    const { gh, api } = await fixture(); api.pr.body = 'Original description';
    await reconcilePR(gh, 1);
    api.pr.body = api.pr.body!.replace('Original description', 'Edited description') + '\n\nAdditional reproduction steps.\n';
    api.runs[0].conclusion = 'failure';
    await reconcilePR(cold(gh, api), 1);
    expect(api.pr.body!.split(PROGRESS_START)[0]).toBe('Edited description\n\nAdditional reproduction steps.\n\n\n');
    expect(api.pr.body!.endsWith(PROGRESS_END)).toBe(true);
    expect(api.pr.body).toContain('- [ ] CI');
    const body = api.pr.body;
    await reconcilePR(cold(gh, api), 1);
    expect(api.pr.body).toBe(body);
  });

  it('uses the latest author description even when the rendered PR snapshot is older', async () => {
    const { gh, api } = await fixture();
    const pr = await getPR(gh, 1), state = await prState(gh, pr), result = await gate(gh, pr);
    api.pr.body = 'Author edit made during CI lookup';
    await summarize(gh, pr, state, result);
    expect(api.pr.body!.startsWith('Author edit made during CI lookup\n\n')).toBe(true);
  });

  it('retries when an author edits the description during the write check', async () => {
    const { gh, api } = await fixture();
    const pr = await getPR(gh, 1), state = await prState(gh, pr), result = await gate(gh, pr);
    let reads = 0;
    api.extra = async route => { if (route === `GET ${pullRoute}` && ++reads === 2) api.pr.body = 'Concurrent author edit'; };
    await expect(summarize(gh, pr, state, result)).rejects.toThrow('description changed');
    expect(edits(api)).toHaveLength(0);
    expect(api.pr.body).toBe('Concurrent author edit');
    api.extra = undefined;
    await reconcilePR(cold(gh, api), 1);
    expect(api.pr.body!.startsWith('Concurrent author edit\n\n')).toBe(true);
  });

  it.each([1, 2])('refuses stale progress when the head changes on read %s', async read => {
    const { gh, api } = await fixture();
    const pr = await getPR(gh, 1), state = await prState(gh, pr), result = await gate(gh, pr);
    let reads = 0;
    api.extra = async route => { if (route === `GET ${pullRoute}` && ++reads === read) api.pr.head.sha = 'newhead'; };
    await expect(summarize(gh, pr, state, result)).rejects.toThrow('PR changed');
    expect(edits(api)).toHaveLength(0);
    expect(api.pr.body).toBe('');
  });

  it('recovers a lost description update response without a duplicate section or write', async () => {
    const { gh, api } = await fixture(); api.pr.body = 'Keep this description';
    const request = api.request.bind(api); let lost = false;
    api.request = async (route, args) => {
      const response = await request(route, args);
      if (!lost && route === `PATCH ${pullRoute}`) { lost = true; throw new Error('Lost description response'); }
      return response;
    };
    await expect(reconcilePR(gh, 1)).rejects.toThrow('Lost description response');
    await reconcilePR(cold(gh, api), 1);
    expect(edits(api)).toHaveLength(1);
    expect(api.pr.body!.split(PROGRESS_START)).toHaveLength(2);
    expect(api.pr.body!.startsWith('Keep this description\n\n')).toBe(true);
  });

  it.each(['environment', 'repository'])('keeps descriptions and comments untouched in %s dry run', async source => {
    const { gh, api } = await fixture(); api.pr.body = 'Keep unchanged';
    if (source === 'environment') gh.env.DRY_RUN = 'true'; else gh.config!.dryRun = true;
    await reconcilePR(gh, 1);
    expect(api.pr.body).toBe('Keep unchanged');
    expect(api.writes()).toHaveLength(0);
    expect(api.comments).toHaveLength(0);
  });

  it.each([PROGRESS_START, PROGRESS_END, `${PROGRESS_END}\n${PROGRESS_START}`, `${PROGRESS_START}\n${PROGRESS_START}\n${PROGRESS_END}`])('leaves malformed sections intact: %s', async markers => {
    const { gh, api } = await fixture(); api.pr.body = 'Author text\n\n' + markers;
    const original = api.pr.body;
    await expect(reconcilePR(gh, 1)).rejects.toThrow('Malformed Piper progress markers');
    expect(api.pr.body).toBe(original);
    expect(edits(api)).toHaveLength(0);
  });

  it('preserves an oversized description instead of truncating author text', async () => {
    const { gh, api } = await fixture(); api.pr.body = 'x'.repeat(65500);
    await expect(reconcilePR(gh, 1)).rejects.toThrow('body limit');
    expect(api.pr.body).toHaveLength(65500);
    expect(edits(api)).toHaveLength(0);
  });

  it('does not trust recovery records or manually checked progress in the description', async () => {
    const { gh, api } = await fixture();
    const forged = encodeRecord(repo, 1, 'command-state:auto', { order: 99, actor: 'alice', head: 'abc123', change: { kind: 'integrate', cancelled: false, mode: 'auto' } });
    api.pr.body = `${forged}\n\n${PROGRESS_START}\n- [x] CI\n${PROGRESS_END}`;
    api.runs[0].conclusion = 'failure';
    await reconcilePR(gh, 1, true);
    expect((await prState(gh, api.pr)).integration).toBe('none');
    expect(api.pr.body).toContain('- [ ] CI');
    expect(api.pr.body!.startsWith(forged)).toBe(true);
    expect(api.pr.merged).toBe(false);
  });
});
