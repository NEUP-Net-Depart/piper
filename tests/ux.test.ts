import { describe, expect, it, vi } from 'vitest';
import { executeCommand, parseCommand } from '../src/commands';
import { GitHub } from '../src/github';
import { commandHelp } from '../src/help';
import { gate, notifyPR, reconcilePR } from '../src/pulls';
import { prState, visibleComment } from '../src/records';
import { prepareRelease, releaseFor, syncRelease } from '../src/releases';
import { integrationNotice, summarize, READY_MARKER, PROGRESS_START } from '../src/status';
import { fixture, type FakeGitHub } from './fixtures';

const body = (api: FakeGitHub, marker: string) =>
  marker === PROGRESS_START ? api.pr.body! : visibleComment(api.comments.find((c) => c.body.startsWith(marker))!.body);
const cold = (gh: GitHub, api: FakeGitHub, id = 'refresh') => {
  const next = new GitHub(gh.env, gh.repo, id, api);
  next.config = gh.config;
  return next;
};
async function command(gh: GitHub, api: FakeGitHub, id: number, text: string, isPR = true) {
  const next = cold(gh, api, 'ux-' + id);
  next.commandOrder = id;
  await executeCommand(next, 1, 'alice', parseCommand(text)!, isPR);
  return next.commandResult;
}

describe('actionable collaboration guidance', () => {
  it('keeps waiting conditions separate from work the author can do now', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.pr.requested_reviewers = [{ login: 'bob' }];
    api.reviews = [];
    api.runs[0].status = 'in_progress';
    api.runs[0].conclusion = null;
    await reconcilePR(gh, 1);
    await notifyPR(gh, 1);
    const waiting = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(waiting).toContain('作者暂时无需操作');
    expect(waiting).toContain('**审查者** [bob]');
    expect(waiting).not.toContain('#### 需要处理');
    expect(waiting).not.toContain('/integrate');
    expect(api.comments.some((c) => c.body.startsWith(READY_MARKER))).toBe(false);

    api.runs[0].status = 'completed';
    api.runs[0].conclusion = 'failure';
    await reconcilePR(cold(gh, api), 1);
    const failed = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(failed).not.toContain('作者暂时无需操作');
    expect(failed).toContain('**作者**：打开 Checks');
    expect(failed.indexOf('#### 需要处理')).toBeLessThan(failed.indexOf('#### 等待处理'));
  });

  it('keeps stale approval history separate from current review assignments', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.pr.head.sha = 'newsha';
    api.runs[0].head_sha = 'newsha';
    await reconcilePR(gh, 1);
    const visible = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(visible).not.toContain('**审查者** [bob]');
    expect(visible).toContain('/reviewers add');
    expect(body(api, PROGRESS_START)).toContain('批准对应旧提交');
  });

  it.each(['ci', 'review', 'unknown'])('keeps blocked merge gates closed and diagnoses %s', async (cause) => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.pr.mergeable_state = 'blocked';
    if (cause === 'ci') api.runs[0].status = 'in_progress';
    if (cause === 'review') {
      api.reviews = [];
      api.pr.requested_reviewers = [{ login: 'bob' }];
    }
    const result = await gate(gh, api.pr);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('GitHub 合并状态：blocked');
    const branch = result.progress.find((p) => p.name === 'GitHub 分支规则')!;
    expect(branch.owner).toBe(cause === 'unknown' ? '维护者' : undefined);
    await summarize(gh, api.pr, await prState(gh, api.pr), result);
    const visible = body(api, PROGRESS_START).split('<details>')[0]!;
    if (cause !== 'unknown') {
      expect(visible).not.toContain('按提示补齐分支保护要求');
      expect(visible).toContain('- [ ] GitHub 分支规则');
    } else expect(visible).toContain('按提示补齐分支保护要求');
  });

  it.each(['dirty', 'behind'])('assigns %s recovery to the author without opening the gate', async (mergeState) => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.pr.mergeable_state = mergeState;
    api.pr.mergeable = mergeState !== 'dirty';
    const result = await gate(gh, api.pr);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(`GitHub 合并状态：${mergeState}`);
    await summarize(gh, api.pr, await prState(gh, api.pr), result);
    const visible = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(visible).toContain('**作者**');
    expect(visible).not.toContain('**维护者**');
    expect(visible).not.toContain('/integrate');
    expect(visible.match(/^- \*\*作者\*\*/gm)).toHaveLength(1);
    expect(visible).toContain(mergeState === 'dirty' ? '解决冲突后推送' : '最新代码同步到当前分支并推送');
    expect(api.pr.merged).toBe(false);
  });

  it('only asks eligible historical approvers to review again', async () => {
    const { gh, api } = await fixture();
    api.reviews = ['bob', 'alice', 'mallory', 'robot'].map((login, id) => ({
      id,
      user: { login, type: login === 'robot' ? 'Bot' : 'User' },
      state: 'APPROVED',
      commit_id: 'oldsha',
    }));
    api.permissions.robot = 'write';
    const result = await gate(gh, api.pr);
    expect(result.outdatedReviewers).toEqual(['bob']);
    await summarize(gh, api.pr, await prState(gh, api.pr), result);
    const visible = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(visible).not.toContain('**审查者** [bob]');
    for (const login of ['alice', 'mallory', 'robot']) expect(visible).not.toContain(`[${login}]`);
    const reapprove = body(api, PROGRESS_START)
      .split('\n')
      .filter((line) => line.includes('该历史批准不代表当前审查任务'));
    expect(reapprove).toHaveLength(1);
    expect(reapprove[0]).toContain('[bob]');
  });

  it.each([0, 299, 300, 600])('waits for CI startup for five minutes, age %s seconds', async (seconds) => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { gh, api } = await fixture();
      await gh.record(1, 'ci-head-seen:' + api.pr.head.sha, { at: now - seconds * 1000 });
      api.runs = [];
      const result = await gate(gh, api.pr);
      expect(result.ready).toBe(false);
      expect(result.reasons).toContain('CI 缺失：verify');
      const ci = result.progress.find((p) => p.name === 'CI · verify')!;
      expect(ci.owner).toBe(seconds < 300 ? '等待' : '维护者');
      await summarize(gh, api.pr, await prState(gh, api.pr), result);
      const visible = body(api, PROGRESS_START).split('<details>')[0]!;
      if (seconds < 300) {
        expect(visible).toContain('等待 CI 启动');
        expect(visible).not.toContain('检查工作流配置');
      } else expect(visible).toContain('检查工作流配置');
    } finally {
      clock.mockRestore();
    }
  });

  it('migrates a legacy placeholder without claiming there was a preview', async () => {
    const { gh, api } = await fixture();
    api.reviews = [];
    api.comments.push({
      id: 99,
      issue_number: 1,
      user: { login: gh.env.BOT_LOGIN, type: 'Bot' },
      body: READY_MARKER + '\n等待检查通过。',
    });
    await notifyPR(gh, 1);
    expect(body(api, READY_MARKER)).toContain('当前尚未满足合并条件');
    expect(body(api, READY_MARKER)).not.toContain('预览已失效');
    expect(api.comments.filter((c) => c.body.startsWith(READY_MARKER))).toHaveLength(1);
    expect(api.comments.find((c) => c.body.startsWith(READY_MARKER))!.id).toBe(99);
  });

  it.each(['eligible', 'external', 'risk'])('uses one primary action for policy auto: %s', async (kind) => {
    const { gh, api } = await fixture('merge:\n  auto: true');
    if (kind === 'external') api.pr.user.login = 'outsider';
    if (kind === 'risk') api.files = [{ filename: 'migrations/change.sql' }];
    const result = await gate(gh, api.pr),
      state = await prState(gh, api.pr);
    await summarize(gh, api.pr, state, result);
    await integrationNotice(gh, api.pr, state, result);
    for (const marker of [PROGRESS_START, READY_MARKER]) {
      const visible = body(api, marker).split('<details>')[0]!;
      if (kind === 'eligible') {
        expect(visible).toContain('等待核验并合并，无需发送命令');
        expect(visible).not.toContain('/integrate');
      } else {
        expect(visible).toContain('/integrate');
        expect(visible).not.toContain('等待核验并合并，无需发送命令');
      }
    }
  });

  it('puts owners and recovery actions before details and stops asking for a reviewer once approved', async () => {
    const { gh, api } = await fixture('reviewers:\n  count: 0');
    api.reviews = [];
    api.runs[0].conclusion = 'failure';
    await reconcilePR(gh, 1);
    const initial = body(api, PROGRESS_START),
      visible = initial.split('<details>')[0]!;
    expect(visible).toContain('**作者**：');
    expect(visible).toContain('查看日志');
    expect(visible).toContain('**维护者**：当前没有待处理的审查请求');
    expect(visible).toContain('/reviewers add 用户名');
    expect(visible).not.toContain('/integrate');
    expect(initial.indexOf('需要处理')).toBeLessThan(initial.indexOf('检查进度'));
    api.runs[0].conclusion = 'success';
    api.reviews = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: api.pr.head.sha }];
    await reconcilePR(cold(gh, api), 1);
    const ready = body(api, PROGRESS_START).split('<details>')[0]!;
    expect(ready).not.toContain('/reviewers add');
    expect(ready).toContain('`/integrate`');
    expect(api.pr.merged).toBe(false);
  });

  it('keeps status and notice consistent for an automatic request, cancellation and a newer commit', async () => {
    const { gh, api } = await fixture();
    api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate auto');
    await reconcilePR(cold(gh, api), 1);
    await notifyPR(cold(gh, api), 1);
    expect(api.comments.some((c) => c.body.startsWith(READY_MARKER))).toBe(false);
    for (const marker of [PROGRESS_START]) {
      expect(body(api, marker)).toContain('无需重复发送命令');
      expect(body(api, marker)).not.toContain('后再请求集成');
      expect(body(api, marker)).not.toContain('\n/integrate\n');
    }
    api.runs[0].status = 'completed';
    await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('已开启自动集成');
    expect(body(api, READY_MARKER)).not.toContain('\n/integrate\n');
    await command(gh, api, 2, '/integrate cancel');
    await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('集成请求已取消');
    expect(body(api, READY_MARKER)).toContain('\n/integrate\n');
    api.runs[0].status = 'in_progress';
    await command(gh, api, 3, '/integrate auto');
    api.pr.head.sha = 'newsha';
    await notifyPR(cold(gh, api), 1);
    expect(body(api, READY_MARKER)).toContain('旧的集成请求已失效');
    expect(body(api, READY_MARKER)).not.toContain('已开启自动集成');
  });

  it('explains that an unsuccessful manual request will not merge later by itself', async () => {
    const { gh, api } = await fixture();
    api.runs[0].status = 'in_progress';
    await command(gh, api, 1, '/integrate');
    api.runs[0].status = 'completed';
    await reconcilePR(cold(gh, api), 1);
    await notifyPR(cold(gh, api), 1);
    expect(api.pr.merged).toBe(false);
    for (const marker of [PROGRESS_START, READY_MARKER]) {
      expect(body(api, marker)).toContain('没有登记自动合并');
      expect(body(api, marker)).toContain('/integrate');
      expect(body(api, marker)).not.toContain('无需重复发送命令');
    }
  });

  it('replaces a stale ready notice when the commit preview cannot be completed', async () => {
    const { gh, api } = await fixture();
    await notifyPR(gh, 1);
    api.extra = async (route, args) =>
      route.endsWith('/pulls/{pull_number}/commits')
        ? Array.from({ length: args.page <= 2 ? 100 : 50 }, () => ({
            commit: { author: { name: 'Alice', email: 'alice@example.test' } },
          }))
        : undefined;
    await notifyPR(cold(gh, api), 1);
    await reconcilePR(cold(gh, api), 1);
    expect(body(api, PROGRESS_START)).toContain('250 条读取上限');
    expect(body(api, PROGRESS_START).split('<details>')[0]).not.toContain('`/integrate`');
    expect(body(api, READY_MARKER)).not.toContain('\n/integrate\n');
    expect(api.comments.filter((c) => c.body.startsWith(READY_MARKER))).toHaveLength(1);
  });
});

describe('discoverable help and review commands', () => {
  it('answers help topics in Issues without fetching PR data or changing merge settings', async () => {
    const { gh, api } = await fixture();
    await command(gh, api, 1, '/help integrate', false);
    const reply = api.comments.at(-1).body;
    expect(reply).toContain('立即尝试一次');
    expect(reply).toContain('不会排队');
    expect(reply).toContain('同义命令，不会立即合并');
    expect(api.calls.some((c) => c.route.includes('/pulls/'))).toBe(false);
    expect((await prState(gh, api.pr)).integrate_mode).toBeNull();
    expect(commandHelp('', false)).toContain('这里是 Issue');
    expect(commandHelp('all')).toContain('/backport');
    expect(commandHelp('')).not.toContain('/backport');
    expect(() => commandHelp('missing')).toThrow('/help all');
    await expect(command(gh, api, 2, '/intergate', false)).rejects.toThrow('未知命令');
  });

  it('distinguishes ordinary integration from release publication in release PR help', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true');
    await prepareRelease(gh, new Date('2026-10-15T10:00:00Z'));
    await command(gh, api, 1, '/help');
    const reply = api.comments.at(-1).body;
    expect(reply).toContain('| 合并普通 PR | `/integrate` |');
    expect(reply).toContain('| 确认版本发布（维护者） | `/release publish` |');
    expect(reply).not.toContain('合并当前 PR');
  });

  it('reports the effective approval count and explains how to recover an empty review queue', async () => {
    const { gh, api } = await fixture('merge:\n  minApprovals: 2');
    api.reviews = [];
    await command(gh, api, 1, '/reviewers');
    expect(api.comments.at(-1).body).toContain('0/2');
    expect(api.comments.at(-1).body).toContain('/reviewers add 用户名');
    await command(gh, api, 2, '/reviewers add bob');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'bob' }]);
    const result = await command(gh, api, 3, '/reviewers handoff bob carol');
    expect(result).toContain('交接给 [carol]');
    expect(result).toContain('Review changes');
    expect(api.pr.requested_reviewers).toEqual([{ login: 'carol' }]);
  });

  it('does not claim to have sent a review request while the PR is a draft', async () => {
    const { gh, api } = await fixture();
    api.pr.draft = true;
    await expect(command(gh, api, 1, '/reviewers add bob')).rejects.toThrow('Ready for review');
    expect(api.pr.requested_reviewers).toEqual([]);
    expect(api.writes()).toEqual([]);
  });
});

describe('release progress for developers', () => {
  it('guides approval, deployment failure and publication with the actual release state', async () => {
    const { gh, api } = await fixture('release:\n  enabled: true\n  minApprovals: 2');
    const row = (await prepareRelease(gh, new Date('2026-10-15T10:00:00Z')))!;
    await command(gh, api, 1, '/reviewers');
    expect(api.comments.at(-1).body).toContain('1/2');
    await expect(command(gh, api, 7, '/reviewers 1')).rejects.toThrow('2–10');
    await command(gh, api, 2, '/release status');
    expect(api.comments.at(-1).body).toContain('等待审查与发布确认');
    expect(api.comments.at(-1).body).toContain('/release publish');
    api.reviews.push({ id: 2, user: { login: 'carol', type: 'User' }, state: 'APPROVED', commit_id: api.pr.head.sha });
    await command(gh, api, 3, '/release publish');
    expect(api.comments.at(-1).body).toContain('代码已合并；部署成功后创建版本 Tag 和 Release');
    await command(gh, api, 4, '/release status');
    expect(api.comments.at(-1).body).toContain('已合并，等待部署');
    api.workflows = [
      {
        id: 1,
        run_attempt: 1,
        head_sha: 'merge123',
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    await command(gh, api, 5, '/release status');
    expect(api.comments.at(-1).body).toContain('修复并重跑工作流');
    expect(api.comments.at(-1).body).toContain('/actions/workflows/ci.yml');
    api.workflows[0].conclusion = 'success';
    await syncRelease(cold(gh, api), row);
    expect((await releaseFor(cold(gh, api), api.pr))?.state).toBe('published');
    await command(gh, api, 6, '/release status');
    expect(api.comments.at(-1).body).toContain('/releases/tag/v0.1.0');
    expect(api.comments.at(-1).body).toContain('无需继续操作');
  });
});
