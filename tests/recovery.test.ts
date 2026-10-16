import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github';
import { executeCommand, parseCommand } from '../src/commands';
import { assign, getPR, reconcilePR, rotate } from '../src/pulls';
import { prState } from '../src/records';
import { prepareRelease, publishRelease, releaseFor, syncRelease } from '../src/releases';
import { backport } from '../src/backport';
import { processJob, tick } from '../src/worker';
import { sha256, type Job } from '../src/types';
import { fixture, FakeGitHub, repo, testEnv } from './fixtures';

function cold(gh: GitHub, api: FakeGitHub, id = gh.job, order = gh.commandOrder) {
  const next = new GitHub(gh.env,gh.repo,id,api); next.config = gh.config; next.commandOrder = order; return next;
}
function loseResponse(api: FakeGitHub, route: string) {
  const request = api.request.bind(api); let lost = false;
  api.request = async (path, args) => {
    const result = await request(path,args);
    if (!lost && path === route) { lost = true; throw new Error('Response lost after GitHub committed'); }
    return result;
  };
}
const command = (gh: GitHub, api: FakeGitHub, id: number, body: string, actor = 'alice') => executeCommand(cold(gh,api,'command-' + id,id),1,actor,parseCommand(body)!,true);
const count = (api: FakeGitHub, route: string) => api.calls.filter(c => c.route === route).length;
const reviewerPost = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers';
const reviewerDelete = 'DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers';
const mergeRoute = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge';

describe('review recovery from native plans and timelines', () => {
  it('does not request again after a lost response and a review submitted before retry', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob,carol]\n  count: 1'); api.reviews = [];
    loseResponse(api,reviewerPost);
    await expect(assign(gh,api.pr)).rejects.toThrow('Response lost');
    api.pr.requested_reviewers = []; api.reviews.push({ id: 2, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: new Date().toISOString() });
    await assign(cold(gh,api),await getPR(gh,1));
    expect(count(api,reviewerPost)).toBe(1); expect(api.pr.requested_reviewers).toEqual([]);
  });
  it('finishes a partial rotation with the planned replacement after a lost request response', async () => {
    const { gh, api } = await fixture('reviewers:\n  pool: [bob,carol]\n  count: 1'); api.reviews = [];
    api.pr.requested_reviewers = [{ login: 'bob' }];
    api.timeline = [{ id: 1, event: 'review_requested', requested_reviewer: { login: 'bob' }, created_at: new Date(Date.now()-49*3600000).toISOString() }];
    loseResponse(api,reviewerPost); await expect(rotate(gh,await getPR(gh,1))).rejects.toThrow('Response lost');
    await rotate(cold(gh,api,'later-cron'),await getPR(gh,1));
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]); expect(count(api,reviewerPost)).toBe(1);
    expect(api.calls.findIndex(c => c.route === reviewerPost)).toBeLessThan(api.calls.findIndex(c => c.route === reviewerDelete));
  });
  it('recovers manual handoff when removal succeeded but its response was lost', async () => {
    const { gh, api } = await fixture(); api.pr.requested_reviewers = [{ login: 'bob' }];
    loseResponse(api,reviewerDelete);
    await expect(command(gh,api,10,'/reviewers handoff bob carol')).rejects.toThrow('Response lost');
    await command(gh,api,10,'/reviewers handoff bob carol');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
    expect(count(api,reviewerPost)).toBe(1); expect(count(api,reviewerDelete)).toBe(1);
  });
});

describe('command state without local persistence', () => {
  it('restores summary, author, coauthors, integration and tag across fresh consumers', async () => {
    const { gh, api } = await fixture(); api.runs[0].conclusion = 'failure'; api.permissions.alice = 'read';
    await command(gh,api,1,'/summary Booking repair');
    await command(gh,api,2,'/author Original <original@example.com>','carol');
    await command(gh,api,3,'/contributor add Helper <helper@example.com>','carol');
    await command(gh,api,4,'/tag booking-fix','carol');
    await command(gh,api,5,'/integrate auto','carol'); expect(api.pr.merged).toBe(false);
    api.runs[0].conclusion = 'success'; await reconcilePR(cold(gh,api,'new-cron'),1);
    const merge = api.calls.find(c => c.route === mergeRoute)!;
    expect(merge.args).toMatchObject({ sha: 'abc123', merge_method: 'squash' });
    for (const text of ['Booking repair','Original-author: Original <original@example.com>','Co-authored-by: Helper <helper@example.com>','Reviewed-by: bob']) expect(merge.args.commit_message).toContain(text);
    expect(api.tags.get('booking-fix')).toBe('merge123');
  });
  it('orders metadata and cancellation by source comment IDs despite queue reordering', async () => {
    const { gh, api } = await fixture();
    await command(gh,api,20,'/summary Newest'); await command(gh,api,10,'/summary Older');
    await command(gh,api,40,'/integrate cancel'); await command(gh,api,30,'/integrate');
    const state = await prState(cold(gh,api),api.pr);
    expect(state.metadata.summary).toBe('Newest'); expect(state.integrate_actor).toBeNull(); expect(api.pr.merged).toBe(false);
  });
  it('pins the head before effects and rejects replay against a later commit', async () => {
    const { gh, api } = await fixture(); api.failAfterComment = true;
    await expect(command(gh,api,1,'/integrate')).rejects.toThrow('Connection lost');
    api.pr.head.sha = 'later'; await expect(command(gh,api,1,'/integrate')).rejects.toThrow('已更新');
    expect(count(api,mergeRoute)).toBe(0);
  });
  it('resumes an interrupted merge by tagging the actual merge SHA only once', async () => {
    const { gh, api } = await fixture(); await command(gh,api,1,'/tag completed');
    loseResponse(api,mergeRoute); await expect(command(gh,api,2,'/integrate')).rejects.toThrow('Response lost');
    await command(gh,api,2,'/integrate'); expect(count(api,mergeRoute)).toBe(1); expect(api.tags.get('completed')).toBe('merge123');
  });
  it('recovers a lost command completion receipt without undoing a later human change', async () => {
    const { gh, api, env } = await fixture(); const body = '/label add bug';
    api.comments.push({ id: 99, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
    const job: Job = { id: 'receipt', repo, installation: 1, kind: 'command', number: 1, commentId: 99, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
    await gh.ensureStatus(1);
    api.failAfterComment = true; expect(await processJob(env,job,api)).toBe('retry');
    api.pr.labels = []; expect(await processJob(env,job,api)).toBe('ack'); expect(api.pr.labels).toEqual([]);
  });
  it('keeps ordinary integration away from a configured release target even if ordinary rules allow it', async () => {
    const { gh, api } = await fixture('merge:\n  auto: true\n  allowedBases: [main]\n  protectedBranches: []\nrelease:\n  enabled: true');
    api.pr.base.ref = 'main'; await command(gh,api,1,'/integrate'); await reconcilePR(cold(gh,api),1);
    expect(count(api,mergeRoute)).toBe(0);
  });
});

it('updates merged state without relying on contribution history or webhook ordering', async () => {
  const { gh, api } = await fixture(); api.pr.merged = true; api.pr.state = 'closed'; api.pr.merged_at = '2026-10-14T00:00:00Z';
  api.issueHistory = [{ number: 1, pull_request: {} },{ number: 2, pull_request: {} }];
  api.extra = async (route,args) => route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && args.pull_number === 2 ? { ...api.pr, number: 2, merged_at: '2026-10-15T00:00:00Z' } : undefined;
  await reconcilePR(gh,1); await reconcilePR(cold(gh,api),1);
  expect(api.comments).toHaveLength(1); expect(api.comments[0].body).toContain('**已合并**');
  expect(api.calls.some(c => c.route === 'GET /repos/{owner}/{repo}/issues')).toBe(false);
});

async function preparedRelease() {
  const f = await fixture('release:\n  enabled: true');
  const row = (await prepareRelease(f.gh,new Date('2026-10-15T10:00:00Z')))!;
  await publishRelease(f.gh,1,'alice');
  f.api.workflows = [{ id: 10, head_sha: 'merge123', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1 }];
  return { ...f, row };
}
describe('release recovery from PR, deployment, tag and release objects', () => {
  it('finishes labeling when PR creation succeeded but its response was lost', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true');
    loseResponse(api,'POST /repos/{owner}/{repo}/pulls'); const date = new Date('2026-10-15T10:00:00Z');
    await expect(prepareRelease(gh,date)).rejects.toThrow('Response lost'); await prepareRelease(cold(gh,api),date);
    expect(count(api,'POST /repos/{owner}/{repo}/pulls')).toBe(1); expect(api.pr.labels).toContainEqual({ name: 'release' });
  });
  it('does not prepare a new cycle when an old prepare command retries after publication', async () => {
    const { gh, api, row } = await preparedRelease(); await syncRelease(gh,row);
    await gh.record(1,'release-prepare:command-99',{ at: '2026-10-15T10:00:00Z' },'Original command cycle');
    await command(gh,api,99,'/release prepare');
    expect(count(api,'POST /repos/{owner}/{repo}/pulls')).toBe(1);
  });
  it.each(['skipped','failure','cancelled','missing','wrong-sha'])('refuses a green workflow with deployment job %s', async state => {
    const { gh, api, row } = await preparedRelease();
    if (state === 'missing') api.workflowJobs = [];
    else if (state === 'wrong-sha') api.workflowJobs[0].head_sha = 'other';
    else api.workflowJobs[0].conclusion = state;
    await syncRelease(cold(gh,api),row); expect(api.tags.size).toBe(0); expect(api.releases).toHaveLength(0);
    expect((await releaseFor(gh,api.pr))?.state).toBe('deployment_failed');
  });
  it('ignores runs for a different merge SHA or workflow event', async () => {
    const { gh, api, row } = await preparedRelease(); api.workflows[0].head_sha = 'other';
    await syncRelease(cold(gh,api),row); api.workflows[0].head_sha = 'merge123'; api.workflows[0].event = 'pull_request';
    await syncRelease(cold(gh,api),row); expect(api.tags.size).toBe(0);
  });
  it.each(['POST /repos/{owner}/{repo}/git/refs','POST /repos/{owner}/{repo}/releases'])('recovers a lost %s response', async route => {
    const { gh, api, row } = await preparedRelease(); loseResponse(api,route);
    await expect(syncRelease(gh,row)).rejects.toThrow('Response lost'); await syncRelease(cold(gh,api),row);
    expect(api.tags.get('v0.1.0')).toBe('merge123'); expect(api.releases).toHaveLength(1); expect(count(api,route)).toBe(1);
  });
  it('refuses an existing conflicting version tag without overwriting it', async () => {
    const { gh, api, row } = await preparedRelease(); api.tags.set('v0.1.0','other');
    await expect(syncRelease(cold(gh,api),row)).rejects.toThrow('拒绝覆盖'); expect(api.tags.get('v0.1.0')).toBe('other'); expect(api.releases).toHaveLength(0);
  });
  it('rejects a manually squashed release even with successful deployment', async () => {
    const { gh, api, row } = await preparedRelease(); api.extra = async route => route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}' ? { parents: [{ sha: 'base123' }] } : undefined;
    await expect(syncRelease(cold(gh,api),row)).rejects.toThrow('Merge Commit'); expect(api.tags.size).toBe(0);
  });
});

async function backportFixture(conflict = false) {
  const f = await fixture('backport:\n  enabled: true\n  targets: [maintenance]');
  f.api.pr.merged = true; f.api.pr.state = 'closed'; f.api.pr.merge_commit_sha = 'source';
  const refs = new Map([['heads/maintenance','target']]);
  const entry = (path: string, sha: string) => ({ path, sha, type: 'blob', mode: '100644' });
  const trees: Record<string, any[]> = { 'before-tree': [entry('app.txt','before-blob')], 'source-tree': [entry('app.txt','after-blob')], 'target-tree': [entry('app.txt','target-blob'),entry('only-target.txt','untouched')] };
  const blobs: Record<string, string> = { 'before-blob': 'a\nb\nc\n', 'after-blob': 'a\nfixed\nc\n', 'target-blob': conflict ? 'a\nconflict\nc\n' : 'a\nb\nc\n' };
  f.api.extra = async (route,args) => {
    if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') return { tree: { sha: args.commit_sha + '-tree' }, parents: [{ sha: 'before' }], author: { name: 'Alice', email: 'alice@example.com', date: '2026-10-15T00:00:00Z' }, committer: { date: '2026-10-15T00:00:00Z' } };
    if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') { if (!trees[args.tree_sha]) throw new Error('Unpinned target read'); return { tree: trees[args.tree_sha], truncated: false }; }
    if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') return { content: btoa(blobs[args.file_sha]!), encoding: 'base64', size: blobs[args.file_sha]!.length };
    if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
      const sha = refs.get(args.ref); if (!sha) throw Object.assign(new Error('not found'),{ status: 404 }); return { object: { sha } };
    }
    if (route === 'POST /repos/{owner}/{repo}/git/trees' || route === 'POST /repos/{owner}/{repo}/git/commits') return { sha: await sha256(JSON.stringify(args)) };
    if (route === 'POST /repos/{owner}/{repo}/git/refs') { refs.set(args.ref.replace('refs/',''),args.sha); return { object: { sha: args.sha } }; }
    if (route === 'POST /repos/{owner}/{repo}/pulls') {
      const p = { ...f.api.pr, number: 2, state: 'open', merged: false, user: { login: 'piper[bot]', type: 'Bot' }, head: { ...f.api.pr.head, ref: args.head }, base: { ...f.api.pr.base, ref: args.base } };
      f.api.prs.push(p); return p;
    }
    return undefined;
  };
  return { ...f, refs };
}
describe('backport recovery without a stored task row', () => {
  it('applies only the patch over the target tree and reuses the same PR after response loss', async () => {
    const { gh, api } = await backportFixture(); loseResponse(api,'POST /repos/{owner}/{repo}/pulls');
    await expect(backport(gh,api.pr,'maintenance')).rejects.toThrow('Response lost');
    expect((await backport(cold(gh,api),api.pr,'maintenance')).number).toBe(2);
    const tree = api.calls.find(c => c.route === 'POST /repos/{owner}/{repo}/git/trees')!;
    expect(tree.args.base_tree).toBe('target-tree'); expect(tree.args.tree).toEqual([{ path: 'app.txt', mode: '100644', type: 'blob', content: 'a\nfixed\nc\n' }]);
    expect(count(api,'POST /repos/{owner}/{repo}/pulls')).toBe(1);
  });
  it('keeps the original target SHA after a crash even if the target branch advances', async () => {
    const { gh, api, refs } = await backportFixture(); loseResponse(api,'POST /repos/{owner}/{repo}/git/commits');
    await expect(backport(gh,api.pr,'maintenance')).rejects.toThrow('Response lost'); refs.set('heads/maintenance','advanced');
    await backport(cold(gh,api),api.pr,'maintenance');
    const commits = api.calls.filter(c => c.route === 'POST /repos/{owner}/{repo}/git/commits');
    expect(commits).toHaveLength(2); expect(commits[0]!.args).toEqual(commits[1]!.args); expect(commits[1]!.args.parents).toEqual(['target']);
  });
  it('leaves Git branches and objects untouched on a patch conflict', async () => {
    const { gh, api } = await backportFixture(true);
    await expect(backport(gh,api.pr,'maintenance')).rejects.toThrow('冲突');
    expect(api.writes().filter(c => c.route.includes('/git/') || c.route.endsWith('/pulls'))).toEqual([]);
  });
});

it('continues Cron discovery for other repositories after one fails, and skips stopped repos', async () => {
  const api = new FakeGitHub(), env = testEnv({ ALLOWED_REPOSITORIES: 'org/failing,org/stopped,org/healthy', STOPPED_REPOSITORIES: 'ORG/STOPPED' });
  api.extra = async (_route,args) => { if (args.repo === 'failing') throw new Error('unavailable'); return undefined; };
  await expect(tick(env,new Date(),api)).rejects.toThrow('Some repositories');
  expect(api.calls.map(c => c.args.repo)).toEqual(['failing','healthy']);
  expect(env.TASKS.send).toHaveBeenCalledWith(expect.objectContaining({ repo: 'org/healthy' }));
});

describe('Free plan request budget', () => {
  it('welcomes, labels, assigns and summarizes a PR within the invocation budget', async () => {
    const { env, api } = await fixture('');
    api.config = 'enabled: true\ndryRun: false\nreviewers:\n  pool: [bob,carol]\n  count: 1\nlabels:\n  - name: bug\n    titlePrefixes: ["fix:"]\nrelease:\n  enabled: true';
    api.reviews = [];
    const job: Job = { id: 'budget-open', repo, installation: 1, kind: 'reconcile', number: 1, time: new Date().toISOString() };
    expect(await processJob(env,job,api)).toBe('ack');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
    expect(api.comments.some(c => c.body.includes('Piper 协作状态'))).toBe(true);
    expect(api.calls.length).toBeLessThanOrEqual(47);
  });
  it('processes integration, attribution, a tag and the completion receipt within the budget', async () => {
    const { gh, api, env } = await fixture('');
    await command(gh,api,1,'/summary Repair');
    await command(gh,api,2,'/contributor add Helper <helper@example.com>');
    await command(gh,api,3,'/tag budget-check');
    const body = '/integrate';
    api.comments.push({ id: 99, issue_number: 1, body, user: { login: 'alice', type: 'User' }, issue_url: `https://api.github.com/repos/${repo}/issues/1` });
    api.calls = [];
    const job: Job = { id: 'budget-integrate', repo, installation: 1, kind: 'command', number: 1, commentId: 99, actor: 'alice', bodyHash: await sha256(body), time: new Date().toISOString() };
    expect(await processJob(env,job,api)).toBe('ack'); expect(api.pr.merged).toBe(true); expect(api.tags.get('budget-check')).toBe('merge123');
    expect(api.calls.length).toBeLessThanOrEqual(47);
  });
});
