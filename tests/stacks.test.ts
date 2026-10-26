import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github';
import { parseConfig } from '../src/config';
import { dependencyGraph, MAX_STACK_PRS } from '../src/stack-graph';
import { manageStacks as manageOnce } from '../src/stack-management';
import { stackFor } from '../src/stacks';
import { gate, integrate, refreshPR } from '../src/pulls';
import { processJob } from '../src/worker';
import type { Env, PR } from '../src/types';
import { FakeGitHub, pull, repo, testEnv } from './fixtures';

const readPR = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const listPR = 'GET /repos/{owner}/{repo}/pulls';
const patchPR = 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}';
const create = 'POST /repos/{owner}/{repo}/stacks';
const append = 'POST /repos/{owner}/{repo}/stacks/{stack_number}/add';
const merge = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async';
const error = (status: number) => Object.assign(new Error('GitHub unavailable'), { status });
function stackedPull(number: number, base = 'dev') {
  return pull({
    number,
    head: { sha: 'sha' + number, ref: 'feat/pr-' + number, repo: { full_name: repo } },
    base: { sha: 'base123', ref: base, repo: { full_name: repo } },
  });
}
class StackGitHub extends FakeGitHub {
  parents = new Map<string, string[]>([
    ['base123', []],
    ['sha72', ['base123']],
    ['sha74', ['sha72']],
  ]);
  refs = new Map([['dev', 'base123']]);
  deleted = new Set<string>();
  before?: (route: string, args: any) => Promise<void>;
  failAfterBase = false;
  failAfterStack = false;
  stackError = 0;
  constructor(rows = [stackedPull(72), stackedPull(74)]) {
    super();
    this.pr = rows[0]!;
    this.prs = rows.slice(1);
    this.config += 'stack:\n  enabled: true\n  dryRun: false\n';
    this.runs[0].head_sha = this.pr.head.sha;
    this.reviews[0].commit_id = this.pr.head.sha;
    this.extra = async (route, args) => {
      await this.before?.(route, args);
      if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}' && args.ref.startsWith('heads/')) {
        const branch = args.ref.slice(6);
        const sha = this.refs.get(branch) ?? this.rows().find((p) => p.head.ref === branch)?.head.sha;
        if (!sha || this.deleted.has(branch)) throw error(404);
        return { object: { sha } };
      }
      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
        const [base, head] = args.basehead.split('...');
        const ancestors = (sha: string): Set<string> => {
          if (!this.parents.has(sha)) throw error(404);
          return new Set([sha, ...this.parents.get(sha)!.flatMap((p) => [...ancestors(p)])]);
        };
        const a = ancestors(base),
          b = ancestors(head);
        const shared = [...a].filter((sha) => b.has(sha)).sort((x, y) => ancestors(y).size - ancestors(x).size)[0];
        if (!shared) throw error(404);
        const ahead = [...b].filter((sha) => !a.has(sha)).length,
          behind = [...a].filter((sha) => !b.has(sha)).length;
        return {
          status: ahead ? (behind ? 'diverged' : 'ahead') : behind ? 'behind' : 'identical',
          ahead_by: ahead,
          behind_by: behind,
          base_commit: { sha: base },
          merge_base_commit: { sha: shared },
        };
      }
      if (route === patchPR && args.base && this.failAfterBase) {
        this.failAfterBase = false;
        this.changeBase(args.pull_number, args.base);
        throw new Error('Lost Base response');
      }
      if (route === create || route === append) {
        if (this.stackError) throw error(this.stackError);
        const stack =
          route === append
            ? this.stacks.find((s) => s.number === args.stack_number)!
            : {
                id: 10 + this.stacks.length,
                number: 75 + this.stacks.length,
                base: { ref: this.find(args.pull_requests[0]).base.ref },
                pull_requests: [],
              };
        for (const number of args.pull_requests) {
          const pr = this.find(number);
          stack.pull_requests.push({
            number,
            state: pr.state,
            merged_at: pr.merged_at ?? null,
            head: { ref: pr.head.ref, sha: pr.head.sha },
          });
        }
        if (route === create) this.stacks.push(stack);
        this.syncHints(stack);
        if (this.failAfterStack) {
          this.failAfterStack = false;
          throw new Error('Lost Stack response');
        }
        return structuredClone(stack);
      }
    };
  }
  rows(): PR[] {
    return [this.pr, ...this.prs];
  }
  find(number: number) {
    return this.rows().find((p) => p.number === number)!;
  }
  focus(number: number) {
    const rows = this.rows();
    this.pr = this.find(number);
    this.prs = rows.filter((p) => p.number !== number);
  }
  changeBase(number: number, base: string) {
    this.find(number).base = {
      ref: base,
      sha: this.refs.get(base) ?? this.rows().find((p) => p.head.ref === base)!.head.sha,
      repo: { full_name: repo },
    };
  }
  syncHints(stack = this.stacks[0]) {
    for (const [index, member] of stack.pull_requests.entries())
      this.find(member.number).stack = {
        id: stack.id,
        number: stack.number,
        size: stack.pull_requests.length,
        position: index + 1,
        base: { ref: stack.base.ref, sha: this.refs.get(stack.base.ref) ?? null },
      };
  }
  stackWrites() {
    return this.calls.filter((c) => c.route === create || c.route === append || (c.route === patchPR && c.args.base));
  }
}
function context(api = new StackGitHub(), overrides: Partial<Env> = {}) {
  const env = testEnv(overrides),
    gh = new GitHub(env, repo, crypto.randomUUID(), api);
  gh.config = parseConfig(env.ORG_DEFAULTS, api.config);
  gh.useReadCache();
  return { gh, api, env };
}
const resume = (f: ReturnType<typeof context>) => context(f.api, f.env).gh;
async function manageStacks(gh: GitHub) {
  for (let round = 0; round <= MAX_STACK_PRS * 2; round++) {
    await manageOnce(gh);
    if (!gh.stackRefreshes.size) return;
    gh.stackRefreshes.clear();
  }
  throw new Error('Stack reconciliation did not settle');
}

describe('automatic dependency discovery', () => {
  it('defaults to a disabled, separately configurable dry-run', () => {
    expect(parseConfig('{}', '').stack).toEqual({ enabled: false, dryRun: true });
    expect(parseConfig('{"stack":{"enabled":true}}', 'stack:\n  dryRun: false').stack).toEqual({
      enabled: true,
      dryRun: false,
    });
    expect(() => parseConfig('{}', 'stack:\n  guess: true')).toThrow();
  });
  it('discovers #72 → #74 from immutable ancestry and creates a native Stack in that order', async () => {
    const f = context();
    expect((await dependencyGraph(f.gh)).parents.get(74)).toBe(72);
    const before = await gate(f.gh, f.api.pr);
    expect(before.ready).toBe(false);
    expect(before.reasons.join(' ')).toContain('等待 Piper');
    expect(before.progress.find((p) => p.name === 'Stack 依赖')!.detail).not.toContain('可独立集成');
    await manageStacks(f.gh);
    expect(f.api.stackWrites().map((c) => [c.route, c.args.pull_number ?? c.args.pull_requests])).toEqual([
      [patchPR, 74],
      [create, [72, 74]],
    ]);
    expect(f.api.find(74).base.ref).toBe('feat/pr-72');
    expect((await gate(f.gh, f.api.pr)).ready).toBe(true);
    expect((await gate(f.gh, f.api.find(74))).reasons.join(' ')).toContain('先合并下层 PR：#72');
    expect(f.api.calls.filter((c) => c.route === create)[0]!.args.headers['x-github-api-version']).toBe('2026-03-10');
    expect(
      f.api.calls
        .filter((c) => c.route.includes('/compare/'))
        .every((c) => !c.args.basehead.includes('dev') && c.args.per_page === 1),
    ).toBe(true);
  });
  it('finds the nearest parent in a three-layer chain, independently of PR number ordering', async () => {
    const api = new StackGitHub([stackedPull(72), stackedPull(74), stackedPull(30)]);
    api.parents.set('sha30', ['sha74']);
    const f = context(api),
      graph = await dependencyGraph(f.gh);
    expect([...graph.parents]).toEqual([
      [74, 72],
      [30, 74],
    ]);
    await manageStacks(f.gh);
    expect(api.stacks[0].pull_requests.map((p: any) => p.number)).toEqual([72, 74, 30]);
    expect(api.find(30).base.ref).toBe('feat/pr-74');
  });
  it('accepts an already chained Base only after proving ancestry', async () => {
    const f = context();
    f.api.changeBase(74, 'feat/pr-72');
    await manageStacks(f.gh);
    expect(f.api.stackWrites().map((c) => c.route)).toEqual([create]);
  });
  it('leaves independent PRs unchanged, including those sharing an older common ancestor', async () => {
    const f = context();
    f.api.parents.set('sha74', ['base123']);
    await manageStacks(f.gh);
    expect(f.api.stackWrites()).toHaveLength(0);
    expect(f.api.comments).toHaveLength(0);
    expect((await gate(f.gh, f.api.pr)).ready).toBe(true);
  });
  it('pauses diverged HEADs that still share unmerged feature history', async () => {
    const f = context();
    f.api.parents.set('shared', ['base123']);
    f.api.parents.set('sha72', ['shared']);
    f.api.parents.set('sha74', ['shared']);
    await manageStacks(f.gh);
    expect(f.api.stackWrites()).toHaveLength(0);
    expect((await stackFor(f.gh, f.api.pr)).blocked).toContain('当前 HEAD 已分叉');
  });
  it.each(['fork', 'release', 'different-target', 'already-in-target'])('excludes %s dependencies', async (mode) => {
    const f = context();
    if (mode === 'fork') f.api.find(74).head.repo!.full_name = 'someone/fork';
    if (mode === 'release') {
      f.api.find(74).body = '<!-- piper-release:v1:2026-10-26:v1.0.0:abc -->';
      f.api.find(74).base.ref = 'main';
    }
    if (mode === 'different-target') {
      f.gh.config!.merge.allowedBases.push('stable');
      f.api.refs.set('stable', 'base123');
      f.api.find(74).base.ref = 'stable';
    }
    if (mode === 'already-in-target') f.api.refs.set('dev', 'sha72');
    await manageStacks(f.gh);
    expect(f.api.stackWrites()).toHaveLength(0);
  });
  it.each(['forked-children', 'multiple-parents', 'identical-heads', 'unproven-base'])(
    'pauses ambiguous history: %s',
    async (mode) => {
      const api = new StackGitHub([stackedPull(72), stackedPull(74), stackedPull(80)]);
      api.parents.set('sha80', ['sha72']);
      if (mode === 'multiple-parents') {
        api.parents.set('sha74', ['base123']);
        api.parents.set('sha80', ['sha72', 'sha74']);
      }
      if (mode === 'identical-heads') api.find(80).head.sha = 'sha74';
      if (mode === 'unproven-base') {
        api.parents.set('sha74', ['base123']);
        api.changeBase(74, 'feat/pr-72');
      }
      const f = context(api);
      await manageStacks(f.gh);
      expect(api.stackWrites()).toHaveLength(0);
      expect((await gate(f.gh, api.find(72))).ready).toBe(false);
    },
  );
  it('does not let a forked component stop an unrelated linear Stack', async () => {
    const api = new StackGitHub([stackedPull(72), stackedPull(74), stackedPull(80), stackedPull(90), stackedPull(91)]);
    api.parents.set('sha80', ['sha72']);
    api.parents.set('sha90', ['base123']);
    api.parents.set('sha91', ['sha90']);
    await manageStacks(context(api).gh);
    expect(api.stacks[0].pull_requests.map((p: any) => p.number)).toEqual([90, 91]);
  });
  it('refuses incomplete comparison evidence and bounded scans', async () => {
    const f = context();
    f.api.parents.delete('sha74');
    await manageStacks(f.gh);
    expect(f.api.stackWrites()).toHaveLength(0);
    for (let n = 100; n < 100 + MAX_STACK_PRS; n++) f.api.prs.push(stackedPull(n));
    await expect(dependencyGraph(f.gh)).rejects.toThrow('超过');
  });
  it('does not treat a human-authored release marker as permission to skip dependency checks', async () => {
    const f = context();
    f.api.find(74).body = '<!-- piper-release:v1:2026-10-26:v1.0.0:abc -->';
    await manageStacks(f.gh);
    expect(f.api.stacks[0].pull_requests.map((p: any) => p.number)).toEqual([72, 74]);
  });
  it('retries temporary discovery transport failures and blocks merges while Stack API access is unavailable', async () => {
    const f = context();
    f.api.before = async (route) => {
      if (route === listPR) throw new Error('Connection reset');
    };
    await expect(manageStacks(f.gh)).rejects.toThrow('Connection reset');
    f.api.before = async (route) => {
      if (route.endsWith('/stacks')) throw error(403);
    };
    await manageStacks(resume(f));
    expect(f.api.stackWrites()).toHaveLength(0);
    await expect(stackFor(resume(f), f.api.pr)).rejects.toThrow('App 具备 Pull requests');
  });
});

describe('idempotent native Stack management and recovery', () => {
  it.each(['stack', 'repository', 'environment'])(
    'honors %s dry-run without Base edits, Stack creation or receipts',
    async (mode) => {
      const f = context();
      if (mode === 'stack') f.gh.config!.stack.dryRun = true;
      if (mode === 'repository') f.gh.config!.dryRun = true;
      if (mode === 'environment') f.env.DRY_RUN = 'true';
      await manageStacks(f.gh);
      expect(f.api.writes()).toHaveLength(0);
      expect((await stackFor(f.gh, f.api.pr)).blocked).toContain('Dry-run');
    },
  );
  it('reconciles duplicate jobs after a cold start with one status receipt per PR', async () => {
    const f = context();
    await manageStacks(f.gh);
    const count = f.api.writes().length;
    await manageStacks(resume(f));
    await manageStacks(resume(f));
    expect(f.api.writes()).toHaveLength(count);
    expect(f.api.comments).toHaveLength(2);
    expect(f.api.comments.every((c) => c.body.startsWith('<!-- piper:status -->'))).toBe(true);
  });
  it.each(['base', 'stack', 'receipt'])('recovers a lost %s response without duplicate mutations', async (mode) => {
    const f = context();
    if (mode === 'base') f.api.failAfterBase = true;
    if (mode === 'stack') f.api.failAfterStack = true;
    if (mode === 'receipt') f.api.failAfterComment = true;
    await expect(manageStacks(f.gh)).rejects.toThrow(/Lost|Connection lost/);
    await manageStacks(resume(f));
    expect(f.api.stacks).toHaveLength(1);
    expect(f.api.stackWrites().filter((c) => c.route === patchPR)).toHaveLength(1);
    expect(f.api.stackWrites().filter((c) => c.route === create)).toHaveLength(1);
    expect(f.api.comments).toHaveLength(2);
    expect((await stackFor(resume(f), f.api.pr)).blocked).toBeUndefined();
  });
  it('appends a new upper PR only to the top of a Piper-managed Stack', async () => {
    const f = context();
    await manageStacks(f.gh);
    f.api.prs.push(stackedPull(80));
    f.api.parents.set('sha80', ['sha74']);
    await manageStacks(resume(f));
    expect(f.api.stackWrites().filter((c) => c.route === create)).toHaveLength(1);
    const added = f.api.stackWrites().filter((c) => c.route === append);
    expect(added).toHaveLength(1);
    expect(added[0]!.args).toMatchObject({
      stack_number: 75,
      pull_requests: [80],
      headers: { 'x-github-api-version': '2026-03-10' },
    });
    expect(f.api.find(80).base.ref).toBe('feat/pr-74');
    await manageStacks(resume(f));
    expect(f.api.stackWrites().filter((c) => c.route === append)).toHaveLength(1);
  });
  it('preserves developer-created native Stacks and refuses to append to them', async () => {
    const f = context();
    await manageStacks(f.gh);
    f.api.comments = [];
    await manageStacks(resume(f));
    f.api.prs.push(stackedPull(80));
    f.api.parents.set('sha80', ['sha74']);
    const count = f.api.stackWrites().length;
    await manageStacks(resume(f));
    expect(f.api.stackWrites()).toHaveLength(count);
    expect((await stackFor(resume(f), f.api.find(80))).blocked).toContain('已有 Stack 由开发者管理');
    expect(f.api.find(80).base.ref).toBe('dev');
  });
  it.each(['base', 'unstack', 'membership'])('preserves a developer change to %s', async (mode) => {
    const f = context();
    await manageStacks(f.gh);
    const count = f.api.stackWrites().length;
    if (mode === 'base') f.api.changeBase(74, 'dev');
    if (mode === 'unstack') {
      f.api.stacks = [];
      for (const pr of f.api.rows()) {
        pr.stack = null;
        f.api.changeBase(pr.number, 'dev');
      }
    }
    if (mode === 'membership') {
      f.api.stacks[0].pull_requests.pop();
      f.api.find(74).stack = null;
      f.api.changeBase(74, 'dev');
    }
    await manageStacks(resume(f));
    expect(f.api.stackWrites()).toHaveLength(count);
    expect((await gate(resume(f), f.api.find(74))).ready).toBe(false);
  });
  it.each([403, 404, 409, 422])(
    'records a GitHub %s failure in the existing receipt and retries after recovery',
    async (status) => {
      const f = context();
      f.api.stackError = status;
      await manageStacks(f.gh);
      await refreshPR(f.gh, 72);
      expect(f.api.pr.body).toContain('GitHub 未接受 Stack 操作');
      expect(f.api.comments).toHaveLength(2);
      f.api.stackError = 0;
      await manageStacks(resume(f));
      expect(f.api.stacks).toHaveLength(1);
      expect((await stackFor(resume(f), f.api.pr)).blocked).toBeUndefined();
    },
  );
  it.each(['head', 'base', 'new-fork', 'deleted', 'conflict'])(
    'rechecks %s after saving intent and before Base mutation',
    async (mode) => {
      const f = context();
      let changed = false;
      f.api.before = async (route) => {
        if (changed || route !== listPR || f.api.comments.length < 2) return;
        changed = true;
        if (mode === 'head') {
          f.api.find(74).head.sha = 'new74';
          f.api.parents.set('new74', ['sha72']);
        }
        if (mode === 'base') f.api.find(74).base.ref = 'manual';
        if (mode === 'new-fork') {
          f.api.prs.push(stackedPull(80));
          f.api.parents.set('sha80', ['sha72']);
        }
        if (mode === 'deleted') f.api.deleted.add('feat/pr-72');
        if (mode === 'conflict') f.api.find(74).mergeable = false;
      };
      await manageStacks(f.gh);
      expect(changed).toBe(true);
      expect(f.api.stackWrites()).toHaveLength(0);
      expect((await gate(resume(f), f.api.pr)).ready).toBe(false);
    },
  );
  it('does not repoint a partly updated chain after a closed lower PR', async () => {
    const f = context();
    f.api.failAfterBase = true;
    await expect(manageStacks(f.gh)).rejects.toThrow('Lost Base');
    f.api.find(72).state = 'closed';
    const count = f.api.stackWrites().length;
    await manageStacks(resume(f));
    expect(f.api.stackWrites()).toHaveLength(count);
    expect((await gate(resume(f), f.api.find(74))).ready).toBe(false);
  });
  it('resumes partial preparation after a normal new commit proves the same dependency', async () => {
    const f = context();
    f.api.failAfterBase = true;
    await expect(manageStacks(f.gh)).rejects.toThrow('Lost Base');
    f.api.find(74).head.sha = 'updated74';
    f.api.parents.set('updated74', ['sha74']);
    await manageStacks(resume(f));
    expect(f.api.stacks).toHaveLength(1);
    expect(f.api.stacks[0].pull_requests[1].head.sha).toBe('updated74');
    expect(f.api.stackWrites().filter((c) => c.route === patchPR)).toHaveLength(1);
  });
  it('preserves a human Base edit even when the Base is changed back to its original value', async () => {
    const f = context();
    f.api.failAfterBase = true;
    await expect(manageStacks(f.gh)).rejects.toThrow('Lost Base');
    f.api.changeBase(74, 'dev');
    f.api.timeline.push({ id: 123, event: 'base_ref_changed', actor: { login: 'alice', type: 'User' } });
    await manageStacks(resume(f));
    expect(f.api.stackWrites()).toHaveLength(1);
    expect(f.api.find(74).base.ref).toBe('dev');
    expect((await stackFor(resume(f), f.api.find(74))).blocked).toContain('已暂停');
  });
  it('ignores only Piper Base-change echoes when recovering a prepared chain', async () => {
    const f = context();
    f.api.failAfterBase = true;
    await expect(manageStacks(f.gh)).rejects.toThrow('Lost Base');
    f.api.timeline.push({ id: 123, event: 'base_ref_changed', actor: { login: f.env.BOT_LOGIN, type: 'Bot' } });
    await manageStacks(resume(f));
    expect(f.api.stacks).toHaveLength(1);
  });
});

describe('restack and merge safety', () => {
  it('waits for GitHub Restack after Squash, then requires CI and approval on the new HEAD', async () => {
    const f = context();
    await manageStacks(f.gh);
    const bottom = f.api.find(72),
      top = f.api.find(74),
      stack = f.api.stacks[0];
    bottom.state = 'closed';
    bottom.merged = true;
    bottom.merged_at = new Date().toISOString();
    Object.assign(stack.pull_requests[0], { state: 'closed', merged_at: bottom.merged_at });
    expect((await gate(resume(f), top)).ready).toBe(false);
    f.api.parents.set('squash72', ['base123']);
    f.api.refs.set('dev', 'squash72');
    f.api.parents.set('restacked74', ['squash72']);
    top.head.sha = 'restacked74';
    f.api.changeBase(74, 'dev');
    stack.pull_requests[1].head.sha = top.head.sha;
    f.api.syncHints();
    f.api.focus(74);
    let result = await gate(resume(f), top);
    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('0 位');
    f.api.runs[0].head_sha = top.head.sha;
    result = await gate(resume(f), top);
    expect(result.ready).toBe(false);
    f.api.reviews[0].commit_id = top.head.sha;
    expect((await gate(resume(f), top)).ready).toBe(true);
    expect(await integrate(resume(f), 74, 'alice', top.head.sha)).toBe(true);
    expect(f.api.calls.find((c) => c.route === merge)!.args).toMatchObject({
      sha: 'restacked74',
      bypass_rules: false,
      merge_method: 'squash',
      merge_action: 'direct_merge',
    });
    expect(f.api.stackWrites().filter((c) => c.route === create)).toHaveLength(1);
    expect(f.api.calls.some((c) => /^(PATCH|POST) .*\/git\//.test(c.route))).toBe(false);
  });
  it('rejects a new fork appearing at the final merge validation', async () => {
    const f = context();
    await manageStacks(f.gh);
    let reads = 0;
    f.api.before = async (route) => {
      if (route === readPR && ++reads === 2) {
        f.api.prs.push(stackedPull(80));
        f.api.parents.set('sha80', ['sha72']);
      }
    };
    expect(await integrate(resume(f), 72, 'alice', 'sha72')).toBe(false);
    expect(f.api.calls.some((c) => c.route === merge)).toBe(false);
  });
  it('blocks integration when a native Stack branch has been deleted', async () => {
    const f = context();
    await manageStacks(f.gh);
    f.api.deleted.add('feat/pr-74');
    expect((await stackFor(resume(f), f.api.pr)).blocked).toContain('源分支已删除');
    expect(await integrate(resume(f), 72, 'alice', 'sha72')).toBe(false);
    expect(f.api.calls.some((c) => c.route === merge)).toBe(false);
  });
  it.each(['ci', 'review', 'protection'])('does not bypass %s after automatically creating a Stack', async (mode) => {
    const f = context();
    await manageStacks(f.gh);
    if (mode === 'ci') f.api.runs[0].conclusion = 'failure';
    if (mode === 'review') f.api.reviews = [];
    if (mode === 'protection') f.api.pr.mergeable_state = 'blocked';
    expect(await integrate(f.gh, 72, 'alice', 'sha72')).toBe(false);
    expect(f.api.stacks).toHaveLength(1);
    expect(f.api.calls.some((c) => c.route === merge)).toBe(false);
  });
  it('recovers missing lifecycle events through the existing repository scan and Queue', async () => {
    const f = context();
    expect(
      await processJob(
        f.env,
        { id: 'cron-stack', repo, installation: 1, kind: 'scan', time: new Date().toISOString() },
        f.api,
      ),
    ).toBe('ack');
    const jobs = (f.env.TASKS.send as any).mock.calls.map((c: any[]) => c[0]);
    for (const job of jobs) expect(await processJob(f.env, job, f.api)).toBe('ack');
    expect(f.api.stacks).toHaveLength(1);
    expect(f.api.find(74).body).toContain('等待下层 #72');
  });
  it('limits each job to one repository mutation and resumes a multi-layer Stack through the Queue', async () => {
    const api = new StackGitHub([stackedPull(72), stackedPull(74), stackedPull(80)]);
    api.parents.set('sha80', ['sha74']);
    const f = context(api);
    const first = {
      id: 'multi-layer',
      repo,
      installation: 1,
      kind: 'reconcile' as const,
      number: 72,
      time: new Date().toISOString(),
    };
    expect(await processJob(f.env, first, api)).toBe('ack');
    expect(api.stackWrites().map((c) => c.args.pull_number)).toEqual([74]);
    let offset = 0;
    for (let round = 0; round < 10; round++) {
      const calls = (f.env.TASKS.send as any).mock.calls;
      const pending = calls.slice(offset).map((c: any[]) => c[0]);
      offset = calls.length;
      if (!pending.length) break;
      for (const job of pending) {
        const before = api.stackWrites().length;
        expect(await processJob(f.env, job, api)).toBe('ack');
        expect(api.stackWrites().length - before).toBeLessThanOrEqual(1);
      }
    }
    expect(api.stacks[0].pull_requests.map((p: any) => p.number)).toEqual([72, 74, 80]);
    expect((f.env.TASKS.send as any).mock.calls.some((c: any[]) => c[1]?.delaySeconds === 5)).toBe(true);
  });
  it('does not run discovery when repository Stack management is disabled', async () => {
    const f = context();
    f.gh.config!.stack.enabled = false;
    await manageStacks(f.gh);
    expect(f.api.calls).toHaveLength(0);
  });
  it('keeps cold Queue jobs within the Worker request budget at the candidate limit', async () => {
    const rows = Array.from({ length: MAX_STACK_PRS }, (_, i) => stackedPull(100 + i));
    const api = new StackGitHub(rows);
    for (let i = 0; i < rows.length; i++) api.parents.set(rows[i]!.head.sha, [i ? rows[i - 1]!.head.sha : 'base123']);
    const f = context(api);
    let job = {
      id: 'bounded',
      repo,
      installation: 1,
      kind: 'reconcile' as const,
      number: 100,
      time: new Date().toISOString(),
    };
    let offset = 0,
      settled = false;
    for (let round = 0; round < MAX_STACK_PRS + 5; round++) {
      const before = api.calls.length;
      expect(await processJob(f.env, job, api)).toBe('ack');
      expect(api.calls.length - before).toBeLessThan(950);
      const calls = (f.env.TASKS.send as any).mock.calls;
      const next = calls
        .slice(offset)
        .map((c: any[]) => c[0])
        .find((j: any) => j.id.startsWith('stack-sync:'));
      offset = calls.length;
      if (!next) {
        settled = true;
        break;
      }
      job = next;
    }
    expect(settled).toBe(true);
    expect(api.stacks[0].pull_requests).toHaveLength(MAX_STACK_PRS);
  });
});
