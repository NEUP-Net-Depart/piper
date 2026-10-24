import { describe, expect, it } from 'vitest';
import { allowed, matches, parseConfig } from '../src/config';
import { parseCommand, executeCommand } from '../src/commands';
import { applyBackport } from '../src/backport';
import { checks, commitMessage, gate, integrate, reconcilePR, tagPR } from '../src/pulls';
import { localTime, nextVersion } from '../src/releases';
import { fixture, pull, repo, testEnv } from './fixtures';
import { prState } from '../src/records';
import { Denied } from '../src/types';

describe('configuration and commands', () => {
  it('defaults to disabled dry-run and safely merges per-repository rules', () => {
    expect(parseConfig('{}', '').enabled).toBe(false);
    const c = parseConfig('{"merge":{"requiredChecks":["ci"]}}', 'enabled: true\nmerge:\n  minApprovals: 2');
    expect(c.merge.requiredChecks).toEqual(['ci']); expect(c.merge.minApprovals).toBe(2); expect(c.dryRun).toBe(true);
  });
  it.each(['enabled: true\nenabled: false', 'merge:\n  minApprovals: 0', '__proto__: {enabled: true}', 'unknown: true', 'reviewers:\n  remindHours: 49\n  rotateHours: 48', 'release:\n  timezone: nonsense', 'backport:\n  targets: ["../main"]'])('rejects unsafe configuration %s', value => expect(() => parseConfig('{}', value)).toThrow());
  it('matches file globs without regex injection', () => {
    expect(matches('**/migrations/**', 'migrations/a.sql')).toBe(true);
    expect(matches('src/**', 'src/a/b.ts')).toBe(true);
    expect(matches('src/*', 'src/a/b.ts')).toBe(false);
    expect(matches('foo.(bar)', 'fooXbar')).toBe(false);
  });
  it('accepts any explicitly allowed repository name and rejects partial matches', () => {
    expect(allowed(testEnv(), repo)).toBe(true);
    expect(allowed(testEnv({ ALLOWED_REPOSITORIES: 'org/project' }), 'ORG/Project')).toBe(true);
    expect(allowed(testEnv(), `${repo}-other`)).toBe(false);
  });
  it('only parses standalone slash commands, not fenced/quoted prose', () => {
    expect(parseCommand('> /integrate')).toBeNull(); expect(parseCommand('```\n/integrate\n```')).toBeNull();
    expect(parseCommand('/summary first\nsecond')).toEqual({ name: 'summary', args: 'first\nsecond' });
  });
  it.each(['reviewers','contributor','author','label','tag','backport','release'])('denies unprivileged %s', async name => {
    const { gh } = await fixture();
    const args: Record<string, string> = { reviewers: 'add bob', contributor: 'add X <x@y.test>', author: 'X <x@y.test>', label: 'add bug', tag: 'test', backport: 'dev', release: 'prepare' };
    await expect(executeCommand(gh, 1, 'mallory', { name, args: args[name] ?? '' }, true)).rejects.toThrow(/权限/);
  });
  it.each(['alice', 'mallory'])('does not accept the removed sponsor command from %s', async actor => {
    const { gh, api } = await fixture();
    await expect(executeCommand(gh, 1, actor, { name: 'sponsor', args: '' }, true)).rejects.toThrow('未知命令');
    expect(api.writes()).toHaveLength(0);
  });
  it('does not let an unrelated user request or directly perform integration', async () => {
    const { gh, api } = await fixture();
    await expect(executeCommand(gh, 1, 'mallory', { name: 'integrate', args: '' }, true)).rejects.toThrow(/权限/);
    await expect(integrate(gh, 1, 'mallory', api.pr.head.sha)).rejects.toThrow(/权限/);
    expect(api.writes()).toHaveLength(0);
  });
  it('refuses injected attribution through summary', async () => {
    const { gh } = await fixture();
    await expect(executeCommand(gh, 1, 'alice', { name: 'summary', args: 'hello\nReviewed-by: boss' }, true)).rejects.toThrow('trailer');
  });
});
describe('merge gates and attribution', () => {
  it('requires current SHA approvals and trusted successful checks', async () => {
    const { gh, api } = await fixture('merge:\n  trustedCheckAppIds: [1]');
    expect((await gate(gh, api.pr)).ready).toBe(true);
    api.reviews[0].commit_id = 'old'; expect((await gate(gh, api.pr)).ready).toBe(false);
    api.reviews[0].commit_id = 'abc123'; api.runs[0].app.id = 999;
    expect(await checks(gh, 'abc123', ['verify'])).toContain('CI 缺失：verify');
  });
  it('does not let a later COMMENTED review erase CHANGES_REQUESTED', async () => {
    const { gh, api } = await fixture();
    api.reviews[0].state = 'CHANGES_REQUESTED'; api.reviews.push({ ...api.reviews[0], id: 2, state: 'COMMENTED' });
    expect((await gate(gh, api.pr)).reasons).toContain('bob 要求修改');
  });
  it.each([{ draft: true }, { mergeable: null }, { mergeable: false }, { mergeable_state: 'blocked' }, { state: 'closed' }])('blocks unsafe PR state %j', async change => {
    const { gh, api } = await fixture(); expect((await gate(gh, { ...api.pr, ...change })).ready).toBe(false);
  });
  it('cannot count self reviews, bots or users who lost write access', async () => {
    const { gh, api } = await fixture();
    api.permissions.bob = 'read'; expect((await gate(gh, api.pr)).ready).toBe(false);
    api.reviews[0].user = { login: 'alice', type: 'User' }; expect((await gate(gh, api.pr)).ready).toBe(false);
  });
  it('requires SHA-pinned squash and preserves authors and reviewers', async () => {
    const { gh, api } = await fixture();
    await integrate(gh, 1, 'alice', 'abc123');
    const merged = api.writes().find(c => c.route.endsWith('/merge-async'))!;
    expect(merged.args).toMatchObject({ sha: 'abc123', merge_method: 'squash', commit_title: 'fix: repair booking (#1)' });
    expect(merged.args.commit_message).not.toContain('Co-authored-by: Alice <alice@example.com>');
    expect(merged.args.commit_message).toContain('Reviewed-by: bob');
  });
  it('rejects stale integration and invalidates pending requests on new heads', async () => {
    const { gh, api } = await fixture();
    await gh.record(1,'command-state:test',{ order: 1, head: 'abc123', actor: 'alice', change: { kind: 'integrate', cancelled: false } },'test intent');
    api.pr.head.sha = 'new';
    expect((await prState(gh,api.pr)).integrate_head).toBeNull();
    await expect(integrate(gh, 1, 'alice', 'abc123')).rejects.toThrow('更新');
  });
  it('never auto-merges a high risk PR solely from auto mode', async () => {
    const { gh, api } = await fixture('merge:\n  auto: true\nreviewers:\n  count: 0');
    api.files = [{ filename: 'migrations/change.sql' }];
    await reconcilePR(gh, 1); expect(api.writes().some(x => x.route.endsWith('/merge-async'))).toBe(false);
  });
  it('deduplicates contributor emails and rejects trailer line injection', () => {
    const message = commitMessage(pull(), { summary: 'Summary', contributors: [{ name: 'A', email: 'a@e.com' }, { name: 'B\nReviewed-by: fake', email: 'b@e.com' }], author: { name: 'A', email: 'a@e.com' } }, ['bob'], []);
    expect(message.commit_message.match(/Co-authored-by:/g)?.length).toBe(1);
    expect(message.commit_message).not.toContain('fake');
  });
  it('will not overwrite ordinary tags or create production version tags', async () => {
    const { gh, api } = await fixture(); api.pr.merged = true; api.pr.merge_commit_sha = 'merge123'; api.tags.set('sample', 'other');
    await expect(tagPR(gh, api.pr, 'sample')).rejects.toThrow('拒绝覆盖');
    await expect(tagPR(gh, api.pr, 'v1.0.0')).rejects.toThrow('版本号');
  });
});
describe('release and patch primitives', () => {
  it('schedules Thursday in Shanghai rather than UTC', () => {
    expect(localTime(new Date('2026-10-15T10:00:00Z'), 'Asia/Shanghai')).toEqual({ date: '2026-10-15', hour: 18, weekday: 4 });
    expect(nextVersion(['v1.9.9','v1.10.0','junk'], 'patch','v0.1.0','2026-10-15')).toBe('v1.10.1');
    expect(nextVersion([], 'date','v0.1.0','2026-10-15')).toBe('v2026.10.15');
  });
  it('applies only the selected diff and refuses conflicting target content', () => {
    expect(applyBackport('a\nb\nc\n', 'a\nfixed\nc\n', 'a\nb\nc\n')).toBe('a\nfixed\nc\n');
    expect(() => applyBackport('a\nb\nc\n', 'a\nfixed\nc\n', 'a\ndifferent\nc\n')).toThrow(Denied);
  });
});
