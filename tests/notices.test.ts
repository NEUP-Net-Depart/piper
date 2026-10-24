import { describe, expect, it } from 'vitest';
import { executeCommand, parseCommand } from '../src/commands';
import { commitMessage } from '../src/commits';
import { GitHub } from '../src/github';
import { notifyPR, reconcilePR } from '../src/pulls';
import { prepareRelease } from '../src/releases';
import { prState, visibleComment } from '../src/records';
import { READY_MARKER } from '../src/status';
import { processJob } from '../src/worker';
import { sha256, type Job } from '../src/types';
import { fixture, repo, type FakeGitHub } from './fixtures';

const readyRows = (api: FakeGitHub) => api.comments.filter(c => c.user?.login === 'piper[bot]' && c.user?.type === 'Bot' && c.body?.startsWith(READY_MARKER));
const cold = (gh: GitHub, api: FakeGitHub, job = gh.job) => { const next = new GitHub(gh.env, gh.repo, job, api); next.config = gh.config; return next; };
const command = (gh: GitHub, api: FakeGitHub, id: number, body: string) => {
  const next = cold(gh, api, 'command-' + id); next.commandOrder = id;
  return executeCommand(next, 1, 'alice', parseCommand(body)!, true);
};

describe('Skara integration notification lifecycle', () => {
  it('first notifies when ready, then updates the same notice across regressions and new commits', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.reviews = [];
    await reconcilePR(gh, 1); await notifyPR(gh, 1); expect(readyRows(api)).toHaveLength(0);
    api.reviews = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: 'abc123', submitted_at: new Date().toISOString() }];
    await notifyPR(cold(gh, api), 1);
    expect(readyRows(api)).toHaveLength(1); const id = readyRows(api)[0].id;
    expect(readyRows(api)[0].body).toContain('已满足 CI 和审查要求');
    expect(readyRows(api)[0].body).toContain('\n/integrate\n');
    expect(readyRows(api)[0].body).not.toContain('Co-authored-by: Alice <alice@example.com>');
    expect(readyRows(api)[0].body).toContain('Reviewed-by: bob');
    expect(readyRows(api)[0].body.indexOf('Reviewed-by: bob')).toBeLessThan(readyRows(api)[0].body.indexOf('\n/integrate\n'));
    const writes = api.writes().length; await notifyPR(cold(gh, api), 1); expect(api.writes()).toHaveLength(writes);
    api.pr.head.sha = 'newsha'; await notifyPR(cold(gh, api), 1);
    expect(readyRows(api)[0].id).toBe(id); expect(readyRows(api)[0].body).toContain(`/pull/1#piper-progress`);
    expect(readyRows(api)[0].body).not.toContain('```');
    expect(readyRows(api)[0].body).not.toContain('@alice');
    api.reviews[0].commit_id = 'newsha'; api.runs[0].head_sha = 'newsha';
    await notifyPR(cold(gh, api), 1); expect(readyRows(api)[0].body).toContain('已满足 CI 和审查要求');
    api.runs[0].conclusion = 'failure'; await notifyPR(cold(gh, api), 1);
    expect(readyRows(api)[0].body).not.toContain('```'); expect(readyRows(api)).toHaveLength(1);
  });

  it('previews exactly the commit message later used for Squash, safely containing Markdown fences', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    const summary = 'A summary\n```\nNot an instruction\n```';
    await command(gh, api, 1, '/summary ' + summary);
    await notifyPR(gh, 1);
    const expected = commitMessage(api.pr, (await prState(gh, api.pr)).metadata, ['bob'], [{ name: 'Alice', email: 'alice@example.com' }]);
    expect(readyRows(api)[0].body).toContain('````\n' + expected.commit_title + '\n\n' + expected.commit_message + '\n````');
    await command(gh, api, 2, '/integrate');
    const merge = api.writes().find(c => c.route.endsWith('/merge-async'))!;
    expect(merge.args.commit_title).toBe(expected.commit_title); expect(merge.args.commit_message).toBe(expected.commit_message);
    expect(merge.args.merge_method).toBe('squash');
  });

  it('shows target branch history from the common ancestor with a bounded list and full comparison', async () => {
    const { gh, api } = await fixture();
    api.extra = async (route, args) => {
      if (route !== 'GET /repos/{owner}/{repo}/compare/{basehead}') return undefined;
      expect(args.basehead).toBe('abc123...base123');
      return { ahead_by: 112, commits: Array.from({ length: 4 }, (_, i) => ({ sha: `target${i}123456`, commit: { message: `Target change ${i}` } })) };
    };
    await notifyPR(gh, 1);
    const body = readyRows(api)[0].body;
    expect(body).toContain('新增了 112 个提交');
    expect(body).toContain('Target change 2');
    expect(body).not.toContain('Target change 3');
    expect(body).toContain('还有 109 个提交');
    expect(body).toContain(`/compare/abc123...base123`);
    expect(body).toContain('其他人工检查');
    expect(body).toContain('通过 Squash 集成');
    expect(body).not.toContain('自动 Rebase');
  });

  it('offers ordinary integration to authors without write permission', async () => {
    const { gh, api } = await fixture(); api.permissions.alice = 'read';
    await notifyPR(gh, 1);
    expect(readyRows(api)[0].body).toContain('\n/integrate\n');
    expect(readyRows(api)[0].body).not.toContain('/sponsor');
  });

  it('lets a read-only author integrate only after CI and review, preserving a single congratulations image', async () => {
    const { gh, env, api } = await fixture('reviewers:\n  count: 0'); api.permissions.alice = 'read';
    const approved = api.reviews[0];
    const request = async () => {
      const id = Math.max(0, ...api.comments.map(c => c.id)) + 1;
      const body = '/integrate';
      api.comments.push({ id, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
      const job: Job = { id: 'author-integrate-' + id, repo, installation: 1, kind: 'command', number: 1, commentId: id, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
      expect(await processJob(env, job, api)).toBe('ack');
    };
    api.runs[0].status = 'in_progress'; await request(); expect(api.pr.merged).toBe(false);
    api.runs[0].status = 'completed'; api.reviews = []; await request(); expect(api.pr.merged).toBe(false);
    api.reviews = [approved]; await reconcilePR(cold(gh, api), 1); expect(api.pr.merged).toBe(false);
    await request(); expect(api.pr.merged).toBe(true);
    await notifyPR(cold(gh, api), 1); await notifyPR(cold(gh, api), 1);
    const visible = api.comments.map(c => visibleComment(c.body)).join('\n');
    expect(visible.match(/已集成到/g)).toHaveLength(1);
    expect(visible).not.toContain('![庆祝合并]');
    expect(visible).not.toContain('🎉');
    expect(visible).toContain('/commit/merge123'); expect(visible).not.toContain('/sponsor');
    expect((await gh.records(1)).filter(r => r.key.startsWith('command-state:')).some(r => (r.value as { change: { kind: string } }).change.kind === 'sponsor-request')).toBe(false);
  });

  it('rejects automatic integration by a read-only author without saving an intent', async () => {
    const { gh, api } = await fixture(); api.permissions.alice = 'read';
    await expect(command(gh, api, 1, '/integrate auto')).rejects.toThrow(/权限/);
    expect((await prState(gh, api.pr)).integrate_head).toBeNull(); expect(api.writes()).toHaveLength(0);
  });

  it('rechecks write permission before immediately executing an automatic request', async () => {
    const { gh, api } = await fixture();
    const request = api.request.bind(api); let permissions = 0;
    api.request = async (route, args) => {
      if (route.includes('/collaborators/{username}/permission') && args.username === 'alice' && ++permissions === 2) api.permissions.alice = 'read';
      return request(route, args);
    };
    await expect(command(gh, api, 1, '/integrate auto')).rejects.toThrow('自动集成');
    expect(api.writes().some(c => c.route.endsWith('/merge-async'))).toBe(false);
  });

  it('updates the notice on close and reopen, and adds no extra welcome or thanks', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    await reconcilePR(gh, 1); await notifyPR(gh, 1); const id = readyRows(api)[0].id;
    api.pr.state = 'closed'; await reconcilePR(gh, 1); await notifyPR(gh, 1);
    expect(readyRows(api)[0].body).toContain('已关闭');
    api.pr.state = 'open'; await reconcilePR(gh, 1); await notifyPR(gh, 1);
    expect(readyRows(api)[0].id).toBe(id); expect(readyRows(api)[0].body).toContain('已满足 CI 和审查要求');
    expect(api.comments).toHaveLength(2);
    const views = api.comments.map(c => visibleComment(c.body)).join('\n');
    expect(views).not.toContain('感谢提交 PR');
  });

  it('reuses the automatic integration reply for the actual commit result', async () => {
    const { env, api } = await fixture(); api.runs[0].status = 'in_progress';
    const body = '/integrate auto', jobId = 'command:' + repo.toLowerCase() + ':99';
    api.comments.push({ id: 99, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
    const job: Job = { id: jobId, repo, installation: 1, kind: 'command', number: 1, commentId: 99, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
    await processJob(env, job, api);
    const marker = '<!-- piper:' + await sha256('command:' + jobId) + ' -->';
    const reply = api.comments.find(c => c.body.startsWith(marker))!; const id = reply.id;
    expect(visibleComment(reply.body)).toContain('条件满足后自动集成');
    api.runs[0].status = 'completed';
    await processJob(env, { ...job, kind: 'reconcile', id: 'ready-event' }, api); expect(api.pr.merged).toBe(true);
    await processJob(env, { ...job, kind: 'status', id: 'merged-status' }, api);
    await processJob(env, { ...job, kind: 'notice', id: 'merged-notice' }, api);
    expect(api.comments.filter(c => c.body.startsWith(marker))).toHaveLength(1);
    expect(api.comments.find(c => c.id === id).body).toContain('/commit/merge123');
    expect(api.comments.find(c => c.id === id).body).not.toContain('条件满足后');
    expect(api.comments.some(c => c.body.startsWith('<!-- piper:integrated -->'))).toBe(false);
    expect(api.pr.body).toContain('**已合并**');
    const writes = api.writes().length;
    await processJob(env, { ...job, kind: 'notice', id: 'merged-again' }, api); expect(api.writes()).toHaveLength(writes);
  });
});

describe('explicit manual and automatic integration', () => {
  it('does not auto-merge after a failed manual request', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0'); api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate'); expect(api.pr.merged).toBe(false);
    expect((await prState(gh, api.pr)).integrate_mode).toBe('manual');
    api.runs[0].status = 'completed'; await reconcilePR(cold(gh, api), 1); expect(api.pr.merged).toBe(false);
    await command(gh, api, 2, '/integrate'); expect(api.pr.merged).toBe(true);
  });

  it('waits for auto, cancels with manual and requires a new request after a new head', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0'); api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate auto'); expect((await prState(gh, api.pr)).integrate_mode).toBe('auto');
    await command(gh, api, 2, '/integrate manual'); expect((await prState(gh, api.pr)).integrate_head).toBeNull();
    await command(gh, api, 3, '/integrate auto'); api.pr.head.sha = 'newsha'; api.runs[0].head_sha = 'newsha'; api.runs[0].status = 'completed'; api.reviews[0].commit_id = 'newsha';
    await reconcilePR(gh, 1); expect(api.pr.merged).toBe(false); expect((await prState(gh, api.pr)).integration).toBe('outdated');
  });

  it('never offers ordinary Squash into the production target even if release scheduling is disabled', async () => {
    const { gh, api } = await fixture('merge:\n  allowedBases: [main]\n  protectedBranches: []\nrelease:\n  enabled: false'); api.pr.base.ref = 'main';
    await command(gh, api, 1, '/integrate'); expect(api.pr.merged).toBe(false);
  });

  it('refuses Squash when the target changes from dev to main during final verification', async () => {
    const { gh, api } = await fixture();
    const request = api.request.bind(api); let reads = 0;
    api.request = async (route, args) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && ++reads === 3) api.pr.base.ref = 'main';
      return request(route, args);
    };
    await command(gh, api, 1, '/integrate');
    expect(api.comments.map(c => c.body).join('\n')).toContain('Target branch changed');
    expect(api.writes().some(c => c.route.endsWith('/merge-async'))).toBe(false);
  });

  it('uses the release command and Merge Commit preview for scheduled production PRs', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true');
    await prepareRelease(gh, new Date('2026-10-15T10:00:00Z'));
    await notifyPR(gh, 1);
    expect(readyRows(api)).toHaveLength(1); expect(readyRows(api)[0].body).toContain('\n/release publish\n');
    expect(readyRows(api)[0].body).toContain('Merge Commit'); expect(readyRows(api)[0].body).not.toContain('Squash');
    expect(readyRows(api)[0].body).toContain('Release v0.1.0 (#1)');
  });

  it('keeps ready notifications within the Free plan request budget', async () => {
    const { env, api } = await fixture('');
    const job: Job = { id: 'notice-budget', repo, installation: 1, kind: 'notice', number: 1, time: new Date().toISOString() };
    expect(await processJob(env, job, api)).toBe('ack'); expect(readyRows(api)).toHaveLength(1);
    expect(api.calls.length).toBeLessThanOrEqual(47);
  });

  it('reuses the release publish result instead of adding a second completion comment', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true');
    await prepareRelease(gh, new Date('2026-10-15T10:00:00Z'));
    await notifyPR(gh, 1); await command(gh, api, 1, '/release publish');
    const before = api.comments.length; await notifyPR(cold(gh, api), 1);
    expect(api.comments).toHaveLength(before);
    expect(api.comments.some(c => c.body.startsWith('<!-- piper:integrated -->'))).toBe(false);
    expect(api.comments.filter(c => visibleComment(c.body).includes('已集成到'))).toHaveLength(1);
    expect(api.writes().find(c => c.route.endsWith('/merge'))?.args.merge_method).toBe('merge');
  });
});
