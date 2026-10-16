import { describe, expect, it } from 'vitest';
import { executeCommand, parseCommand } from '../src/commands';
import { GitHub } from '../src/github';
import { commandHelp } from '../src/help';
import { notifyPR, reconcilePR } from '../src/pulls';
import { prState, STATUS_MARKER, visibleComment } from '../src/records';
import { prepareRelease, releaseFor, syncRelease } from '../src/releases';
import { READY_MARKER } from '../src/status';
import { fixture, type FakeGitHub } from './fixtures';

const body = (api: FakeGitHub, marker: string) => visibleComment(api.comments.find(c => c.body.startsWith(marker))!.body);
const cold = (gh: GitHub, api: FakeGitHub, id = 'refresh') => { const next = new GitHub(gh.env, gh.repo, id, api); next.config = gh.config; return next; };
async function command(gh: GitHub, api: FakeGitHub, id: number, text: string, isPR = true) {
  const next = cold(gh, api, 'ux-' + id); next.commandOrder = id;
  await executeCommand(next, 1, 'alice', parseCommand(text)!, isPR);
  return next.commandResult;
}

describe('actionable collaboration guidance', () => {
  it('puts owners and recovery actions before details and stops asking for a reviewer once approved', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0'); api.reviews = []; api.runs[0].conclusion = 'failure';
    await reconcilePR(gh, 1);
    const initial = body(api, STATUS_MARKER), visible = initial.split('<details>')[0]!;
    expect(visible).toContain('**作者**：'); expect(visible).toContain('查看日志');
    expect(visible).toContain('**维护者**：当前没有待处理的审查请求');
    expect(visible).toContain('/reviewers add 用户名'); expect(visible).not.toContain('/integrate');
    expect(initial.indexOf('接下来做什么')).toBeLessThan(initial.indexOf('检查进度'));
    api.runs[0].conclusion = 'success';
    api.reviews = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: api.pr.head.sha }];
    await reconcilePR(cold(gh, api), 1);
    const ready = body(api, STATUS_MARKER).split('<details>')[0]!;
    expect(ready).not.toContain('/reviewers add'); expect(ready).toContain('\n/integrate\n');
    expect(api.pr.merged).toBe(false);
  });

  it('keeps status and notice consistent for an automatic request, cancellation and a newer commit', async () => {
    const { gh, api } = await fixture(); api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate auto');
    await reconcilePR(cold(gh, api), 1); await notifyPR(cold(gh, api), 1);
    for (const marker of [STATUS_MARKER, READY_MARKER]) {
      expect(body(api, marker)).toContain('无需重复发送命令');
      expect(body(api, marker)).not.toContain('后再请求集成');
      expect(body(api, marker)).not.toContain('\n/integrate\n');
    }
    api.runs[0].status = 'completed'; await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('已开启自动集成');
    expect(body(api, READY_MARKER)).not.toContain('\n/integrate\n');
    await command(gh, api, 2, '/integrate cancel'); await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('集成请求已取消');
    expect(body(api, READY_MARKER)).toContain('\n/integrate\n');
    api.runs[0].status = 'in_progress'; await command(gh, api, 3, '/integrate auto');
    api.pr.head.sha = 'newsha'; await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('旧的集成请求已失效');
    expect(body(api, READY_MARKER)).not.toContain('已开启自动集成');
  });

  it('explains that an unsuccessful manual request will not merge later by itself', async () => {
    const { gh, api } = await fixture(); api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate');
    api.runs[0].status = 'completed'; await reconcilePR(cold(gh, api), 1); await notifyPR(cold(gh, api), 1);
    expect(api.pr.merged).toBe(false);
    for (const marker of [STATUS_MARKER, READY_MARKER]) {
      expect(body(api, marker)).toContain('没有登记自动合并');
      expect(body(api, marker)).toContain('\n/integrate\n');
      expect(body(api, marker)).not.toContain('无需重复发送命令');
    }
  });

  it('replaces a stale ready notice when the commit preview cannot be completed', async () => {
    const { gh, api } = await fixture(); await notifyPR(gh, 1);
    api.extra = async (route, args) => route.endsWith('/pulls/{pull_number}/commits') ? Array.from({ length: args.page <= 2 ? 100 : 50 }, () => ({ commit: { author: { name: 'Alice', email: 'alice@example.test' } } })) : undefined;
    await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('250 条读取上限');
    expect(body(api, READY_MARKER)).not.toContain('\n/integrate\n');
    expect(api.comments.filter(c => c.body.startsWith(READY_MARKER))).toHaveLength(1);
  });
});

describe('discoverable help and review commands', () => {
  it('answers help topics in Issues without fetching PR data or changing merge settings', async () => {
    const { gh, api } = await fixture();
    await command(gh, api, 1, '/help integrate', false);
    const reply = api.comments.at(-1).body;
    expect(reply).toContain('立即尝试一次'); expect(reply).toContain('不会排队'); expect(reply).toContain('同义命令，不会立即合并');
    expect(api.calls.some(c => c.route.includes('/pulls/'))).toBe(false);
    expect((await prState(gh, api.pr)).integrate_mode).toBeNull();
    expect(commandHelp('', false)).toContain('这里是 Issue');
    expect(commandHelp('all')).toContain('/backport');
    expect(() => commandHelp('missing')).toThrow('/help all');
    await expect(command(gh, api, 2, '/intergate', false)).rejects.toThrow('未知命令');
  });

  it('reports the effective approval count and explains how to recover an empty review queue', async () => {
    const { gh, api } = await fixture('merge:\n  minApprovals: 2'); api.reviews = [];
    await command(gh, api, 1, '/reviewers');
    expect(api.comments.at(-1).body).toContain('0/2');
    expect(api.comments.at(-1).body).toContain('/reviewers add 用户名');
    await command(gh, api, 2, '/reviewers add bob');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
    const result = await command(gh, api, 3, '/reviewers handoff bob carol');
    expect(result).toContain('交接给 [carol]'); expect(result).toContain('Review changes');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
  });

  it('does not claim to have sent a review request while the PR is a draft', async () => {
    const { gh, api } = await fixture(); api.pr.draft = true;
    await expect(command(gh, api, 1, '/reviewers add bob')).rejects.toThrow('Ready for review');
    expect(api.pr.requested_reviewers).toEqual([]);
    expect(api.writes()).toEqual([]);
  });
});

describe('release progress for developers', () => {
  it('guides approval, deployment failure and publication with the actual release state', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true\n  minApprovals: 2');
    const row = (await prepareRelease(gh, new Date('2026-10-15T10:00:00Z')))!;
    await command(gh, api, 1, '/reviewers'); expect(api.comments.at(-1).body).toContain('1/2');
    await expect(command(gh, api, 7, '/reviewers 1')).rejects.toThrow('2–10');
    await command(gh, api, 2, '/release status');
    expect(api.comments.at(-1).body).toContain('等待审查与发布确认'); expect(api.comments.at(-1).body).toContain('/release publish');
    api.reviews.push({ id: 2, user: { login: 'carol', type: 'User' }, state: 'APPROVED', commit_id: api.pr.head.sha });
    await command(gh, api, 3, '/release publish');
    expect(api.comments.at(-1).body).toContain('代码已合并；版本是否已发布');
    await command(gh, api, 4, '/release status'); expect(api.comments.at(-1).body).toContain('已合并，等待部署');
    api.workflows = [{ id: 1, run_attempt: 1, head_sha: 'merge123', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure' }];
    await command(gh, api, 5, '/release status');
    expect(api.comments.at(-1).body).toContain('修复并重跑工作流'); expect(api.comments.at(-1).body).toContain('/actions/workflows/ci.yml');
    api.workflows[0].conclusion = 'success';
    await syncRelease(cold(gh, api), row); expect((await releaseFor(cold(gh, api), api.pr))?.state).toBe('published');
    await command(gh, api, 6, '/release status'); expect(api.comments.at(-1).body).toContain('/releases/tag/v0.1.0');
    expect(api.comments.at(-1).body).toContain('无需继续操作');
  });
});
