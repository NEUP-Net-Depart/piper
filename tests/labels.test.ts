import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { executeCommand, parseCommand } from '../src/commands';
import { GitHub } from '../src/github';
import { reviewPolicy } from '../src/labels';
import { gate, reconcilePR, refreshLabels, notifyPR } from '../src/pulls';
import { processJob } from '../src/worker';
import { prState, STATUS_MARKER, visibleComment } from '../src/records';
import { fixture, type FakeGitHub } from './fixtures';

const cold = (gh: GitHub, api: FakeGitHub, job: string) => { const next = new GitHub(gh.env, gh.repo, job, api); next.config = gh.config; return next; };
async function synchronize(gh: GitHub, api: FakeGitHub) {
  for (let i = 0; i < 100; i++) if (!await refreshLabels(cold(gh, api, `sync-${api.calls.length}-${i}`), 1)) return;
  throw new Error('Label reconciliation did not converge');
}
async function command(gh: GitHub, api: FakeGitHub, id: number, body: string) {
  const next = cold(gh, api, 'command-' + id); next.commandOrder = id;
  return executeCommand(next, 1, 'alice', parseCommand(body)!, true);
}
const configured = `labels:
  - name: area/booking
    files: ['src/booking/**']
    reviewers: [carol]
    reviewerCount: 1
    minApprovals: 2
    highRisk: true
reviewers:
  pool: [bob]
  count: 0`;

describe('repository module and workflow labels', () => {
  it('ignores retired sponsor records, keeps metadata recoverable and removes its previously owned label', async () => {
    const { gh, api } = await fixture();
    await gh.record(1, 'command-state:retired', { order: 1, actor: 'alice', head: api.pr.head.sha, change: { kind: 'sponsor-request' } });
    await gh.record(1, 'command-state:summary', { order: 2, actor: 'alice', head: api.pr.head.sha, change: { kind: 'summary', value: 'Preserved summary' } });
    await gh.record(1, 'labels-owned:old', ['sponsor']); api.pr.labels = [{ name: 'sponsor' }];
    const state = await prState(gh, api.pr);
    expect(state.metadata.summary).toBe('Preserved summary'); expect(state.integration).toBe('none');
    expect(state).not.toHaveProperty('sponsorRequested');
    await synchronize(gh, api);
    expect(api.pr.labels).not.toContainEqual({ name: 'sponsor' });
    expect(api.pr.labels).toContainEqual({ name: 'ready' });
    expect((await prState(gh, api.pr)).metadata.summary).toBe('Preserved summary');
  });
  it('creates definitions, synchronizes renamed files and preserves unrelated human labels', async () => {
    const { gh, api } = await fixture(configured);
    api.pr.labels = [{ name: 'human-label' }];
    api.files = [{ filename: 'src/new/file.ts', previous_filename: 'src/booking/file.ts' }];
    await synchronize(gh, api);
    expect(api.pr.labels).toEqual(expect.arrayContaining([{ name: 'area/booking' }, { name: 'rfr' }, { name: 'human-label' }]));
    expect(api.repoLabels.some(l => l.name === 'area/booking')).toBe(true);
    api.files = [{ filename: 'src/other/file.ts' }]; await synchronize(gh, api);
    expect(api.pr.labels).not.toContainEqual({ name: 'area/booking' });
    expect(api.pr.labels).toContainEqual({ name: 'human-label' });
  });

  it('keeps command overrides through repeated scans, restores auto and does not lower path requirements', async () => {
    const { gh, api } = await fixture(configured); api.files = [{ filename: 'src/booking/app.ts' }];
    await synchronize(gh, api); await command(gh, api, 1, '/label remove area/booking'); await synchronize(gh, api);
    expect(api.pr.labels).not.toContainEqual({ name: 'area/booking' });
    expect((await gate(gh, api.pr)).highRisk).toBe(true); expect((await gate(gh, api.pr)).ready).toBe(false);
    await command(gh, api, 2, '/label auto area/booking'); await synchronize(gh, api);
    expect(api.pr.labels).toContainEqual({ name: 'area/booking' });
    await command(gh, api, 3, '/label add area/booking'); api.files = []; await synchronize(gh, api);
    expect(api.pr.labels).toContainEqual({ name: 'area/booking' });
  });

  it('honors human GitHub UI overrides and permits a later auto command to reset them', async () => {
    const { gh, api } = await fixture(configured); api.files = [{ filename: 'src/booking/app.ts' }];
    await synchronize(gh, api); api.pr.labels = api.pr.labels.filter(l => l.name !== 'area/booking');
    api.timeline.push({ event: 'unlabeled', label: { name: 'area/booking' }, actor: { login: 'alice', type: 'User' }, created_at: '2026-01-01T00:00:00Z' });
    await synchronize(gh, api); expect(api.pr.labels).not.toContainEqual({ name: 'area/booking' });
    await command(gh, api, 1, '/label auto area/booking'); await synchronize(gh, api);
    expect(api.pr.labels).toContainEqual({ name: 'area/booking' });
  });

  it('updates ready, auto and integrated labels through draft, new head, merge and closure', async () => {
    const { gh, api } = await fixture(); await synchronize(gh, api);
    expect(api.pr.labels.map(l => l.name)).toEqual(expect.arrayContaining(['rfr', 'ready']));
    api.runs[0].status = 'in_progress'; await command(gh, api, 1, '/integrate auto'); await synchronize(gh, api);
    expect(api.pr.labels).toContainEqual({ name: 'auto' }); expect(api.pr.labels).not.toContainEqual({ name: 'ready' });
    api.pr.draft = true; api.pr.head.sha = 'new'; await synchronize(gh, api);
    expect(api.pr.labels).not.toContainEqual({ name: 'rfr' }); expect(api.pr.labels).not.toContainEqual({ name: 'auto' });
    api.pr.state = 'closed'; api.pr.merged = true; api.pr.merge_commit_sha = 'actual'; await synchronize(gh, api);
    expect(api.pr.labels).toEqual([{ name: 'integrated' }]);
    api.pr.merged = false; await synchronize(gh, api); expect(api.pr.labels).toEqual([]);
  });

  it('routes module reviews and uses the highest matching approval requirement', async () => {
    const { gh, api } = await fixture(configured); api.files = [{ filename: 'src/booking/app.ts' }]; api.reviews = [];
    await reconcilePR(gh, 1); expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
    const status = api.comments.find(c => c.body.startsWith(STATUS_MARKER)).body;
    expect(status).toContain('文件 src/booking/app.ts'); expect(status).toContain('至少 2 位批准者');
    expect(reviewPolicy(gh.config!, api.pr, api.files).minimum).toBe(2);
    await expect(command(gh, api, 1, '/reviewers 1')).rejects.toThrow('不能低于');
    await command(gh, api, 2, '/reviewers 3'); expect((await gate(gh, api.pr)).reasons.join('\n')).toContain('3 位');
    await expect(command(gh, api, 3, '/label add ready')).rejects.toThrow('协作阶段');
    expect(() => parseConfig('{}', 'labels: [{name: ready}]')).toThrow('Workflow labels');
  });

  it('recovers lost ownership writes and label deletion responses without touching human labels', async () => {
    const { gh, api } = await fixture(configured); api.files = [{ filename: 'src/booking/app.ts' }];
    await synchronize(gh, api); api.files = []; let lost = false;
    const request = api.request.bind(api);
    api.request = async (route, args) => { const response = await request(route, args); if (!lost && route.startsWith('DELETE ') && args.name === 'area/booking') { lost = true; throw new Error('Lost deletion response'); } return response; };
    await expect(synchronize(gh, api)).rejects.toThrow('Lost deletion'); await synchronize(gh, api);
    expect(api.pr.labels).not.toContainEqual({ name: 'area/booking' });
    expect(api.writes().filter(c => c.route.startsWith('DELETE ') && c.args.name === 'area/booking')).toHaveLength(1);
  });

  it('keeps label tasks within the request budget', async () => {
    const { env, api } = await fixture('');
    expect(await processJob(env, { id: 'labels-budget', repo: env.ALLOWED_REPOSITORIES, installation: 1, kind: 'labels', number: 1, time: new Date().toISOString() }, api)).toBe('ack');
    expect(api.calls.length).toBeLessThanOrEqual(47);
  });

  it('keeps multiple module requirements at their maximum and unions reviewer pools', async () => {
    const { gh, api } = await fixture(configured + '\n  ');
    gh.config!.labels.push({ ...gh.config!.labels[0]!, name: 'area/other', files: ['src/other/**'], reviewers: ['bob'], minApprovals: 3 });
    const policy = reviewPolicy(gh.config!, api.pr, [{ filename: 'src/booking/a.ts' }, { filename: 'src/other/b.ts' }]);
    expect(policy.minimum).toBe(3); expect(policy.pool.sort()).toEqual(['bob', 'carol']);
  });
  it('treats a rule assigning a risk label as high risk before asynchronous labels are written', async () => {
    const { gh, api } = await fixture('labels:\n  - name: security\n    files: ["src/auth/**"]');
    api.files = [{ filename: 'src/auth/login.ts' }];
    expect(api.pr.labels).toEqual([]); expect((await gate(gh, api.pr)).highRisk).toBe(true);
  });
});

describe('welcoming and command interaction', () => {
  it('welcomes every PR and congratulates every merged PR once with the actual target and image', async () => {
    const { gh, api } = await fixture(); api.issueHistory = [{ number: 0, pull_request: {} }];
    await reconcilePR(gh, 1); expect(api.comments[0].body).toContain('感谢提交 PR');
    api.pr.state = 'closed'; api.pr.merged = true; api.pr.merge_commit_sha = 'actual';
    await reconcilePR(gh, 1); await notifyPR(gh, 1); await notifyPR(gh, 1);
    const visible = api.comments.map(c => visibleComment(c.body)).join('\n');
    expect(visible.match(/你的 PR 已合并/g)).toHaveLength(1); expect(visible).toContain('![庆祝合并](https://piper.example.test/assets/neurobounce.gif)');
    expect(visible).toContain('已集成到 `dev`'); expect(visible).toContain('/commit/actual');
    expect(api.comments.find(c => c.body.startsWith(STATUS_MARKER)).body).not.toContain('期待下一次合作');
  });

  it('accepts prose before a command, rejects ambiguous commands, and ignores quotations and code', () => {
    expect(parseCommand('感谢审查！\n\n/integrate')).toEqual({ name: 'integrate', args: '' });
    for (const text of ['> /integrate', '```sh\n/integrate\n```', '~~~\n/integrate\n~~~', '    /integrate', '<!--\n/integrate\n-->', '<!-- example --> <!--\n/integrate\n-->', '<pre>\n/integrate\n</pre>', '<code>\n/integrate\n</code>']) expect(parseCommand(text)).toBeNull();
    expect(() => parseCommand('/integrate\n/label add bug')).toThrow('一个命令');
    expect(parseCommand('说明\n/summary 多行摘要\n第二行')).toEqual({ name: 'summary', args: '多行摘要\n第二行' });
    expect(parseCommand('```\n<!--\n```\n/integrate')).toEqual({ name: 'integrate', args: '' });
    expect(parseCommand('> 示例命令\n/integrate')).toBeNull();
  });

  it('resolves contributor handles with a GitHub noreply identity when email is private', async () => {
    const { gh, api } = await fixture(); api.extra = async (route, args) => {
      if (route !== 'GET /users/{username}') return undefined;
      if (args.owner || args.repo) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { id: 123, login: 'helper', type: 'User', name: 'Helper', email: null };
    };
    await command(gh, api, 1, '/contributor add @helper');
    expect((await prState(gh, api.pr)).metadata.contributors).toEqual([{ name: 'Helper', email: '123+helper@users.noreply.github.com' }]);
  });

  it('does not celebrate a PR that was closed without merging', async () => {
    const { gh, api } = await fixture(); await reconcilePR(gh, 1); await notifyPR(gh, 1);
    api.pr.state = 'closed'; await reconcilePR(gh, 1); await notifyPR(gh, 1);
    const body = api.comments.map(c => visibleComment(c.body)).join('\n');
    expect(body).toContain('已关闭，未合并'); expect(body).not.toContain('庆祝合并'); expect(body).not.toContain('期待下一次合作');
  });
});
