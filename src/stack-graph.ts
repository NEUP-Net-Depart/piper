import { z } from 'zod';
import type { GitHub } from './github';
import { Denied, statusCode, type PR } from './types';

export const nativeStackSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  base: z.object({ ref: z.string().min(1) }),
  pull_requests: z
    .array(
      z.object({
        number: z.number().int().positive(),
        state: z.enum(['open', 'closed']),
        merged_at: z.string().nullable(),
        head: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
      }),
    )
    .min(1),
});
export type NativeStack = z.infer<typeof nativeStackSchema>;
export const MAX_STACK_PRS = 20;
export interface DependencyGraph {
  prs: Map<number, PR>;
  native: Map<number, NativeStack>;
  targets: Map<number, string>;
  targetHeads: Map<string, string>;
  parents: Map<number, number>;
  problems: Map<number, string>;
  components: number[][];
}
export const sameRepository = (gh: GitHub, pr: PR) =>
  pr.head.repo?.full_name.toLowerCase() === gh.repo.toLowerCase() &&
  pr.base.repo.full_name.toLowerCase() === gh.repo.toLowerCase();
export function stackCandidate(gh: GitHub, pr: PR) {
  const cfg = gh.config!;
  return (
    sameRepository(gh, pr) &&
    pr.state === 'open' &&
    !pr.merged &&
    ![...cfg.merge.allowedBases, ...cfg.merge.protectedBranches, cfg.release.source, cfg.release.target].includes(
      pr.head.ref,
    ) &&
    pr.base.ref !== cfg.release.target &&
    !cfg.merge.protectedBranches.includes(pr.base.ref) &&
    !(pr.user.login === gh.env.BOT_LOGIN && pr.user.type === 'Bot' && pr.body?.startsWith('<!-- piper-release:v1:'))
  );
}
const comparison = z.object({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  base_commit: z.object({ sha: z.string().min(1) }),
  merge_base_commit: z.object({ sha: z.string().min(1) }),
});
const retryRead = (e: unknown) =>
  statusCode(e) >= 500 ||
  statusCode(e) === 429 ||
  (!statusCode(e) && !(e instanceof Denied) && !(e instanceof z.ZodError));
async function relation(gh: GitHub, base: string, head: string) {
  const c = comparison.parse(await gh.compare(base, head));
  if (
    c.base_commit.sha !== base ||
    (c.status === 'ahead' && !(c.ahead_by > 0 && c.behind_by === 0 && c.merge_base_commit.sha === base)) ||
    (c.status === 'behind' && !(c.ahead_by === 0 && c.behind_by > 0 && c.merge_base_commit.sha === head)) ||
    (c.status === 'identical' && !(base === head && c.ahead_by === 0 && c.behind_by === 0)) ||
    (c.status === 'diverged' &&
      !(c.ahead_by > 0 && c.behind_by > 0 && c.merge_base_commit.sha !== base && c.merge_base_commit.sha !== head))
  )
    throw new Denied('Stack失败：Compare 祖先信息不一致');
  return c;
}
export const memberNumbers = (stack: NativeStack) => stack.pull_requests.map((p) => p.number);
export const graphComponent = (graph: DependencyGraph, number: number) =>
  graph.components.find((members) => members.includes(number)) ?? [];
export const graphSnapshot = (graph: DependencyGraph, members: number[]) =>
  JSON.stringify(
    members.map((number) => {
      const pr = graph.prs.get(number)!;
      const target = graph.targets.get(number);
      return [
        number,
        pr.head,
        pr.base,
        target,
        target && graph.targetHeads.get(target),
        graph.parents.get(number),
        graph.native.get(number),
      ];
    }),
  );

// Branch names establish only a possible final target. Compare of immutable SHAs proves every edge.
export async function dependencyGraph(gh: GitHub): Promise<DependencyGraph> {
  const open = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls', { state: 'open' }, undefined, true);
  const candidates = open.filter((pr) => stackCandidate(gh, pr));
  if (candidates.length > MAX_STACK_PRS) throw new Denied(`Stack暂停：待核验 PR 超过 ${MAX_STACK_PRS} 条`);
  if (new Set(open.map((p) => p.number)).size !== open.length) throw new Denied('Stack暂停：PR 列表不完整或重复');
  const prs = new Map(candidates.map((pr) => [pr.number, pr]));
  const graph: DependencyGraph = {
    prs,
    native: new Map(),
    targets: new Map(),
    targetHeads: new Map(),
    parents: new Map(),
    problems: new Map(),
    components: [],
  };
  let stacks: NativeStack[];
  try {
    stacks = z.array(nativeStackSchema).parse(await gh.list('GET /repos/{owner}/{repo}/stacks', {}, undefined, true));
  } catch (e) {
    if ([403, 404].includes(statusCode(e)))
      throw new Denied('Stack失败：无法读取github Stack', {
        cause: e,
      });
    throw e;
  }
  for (const stack of stacks)
    for (const n of memberNumbers(stack)) {
      if (graph.native.has(n)) throw new Denied('Stack暂停：PR 属于多个 Stack');
      graph.native.set(n, stack);
    }
  const links = new Map(candidates.map((p) => [p.number, new Set<number>()]));
  const connect = (a: number, b: number) => {
    if (!prs.has(a) || !prs.has(b)) return;
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  };
  const branches = new Map<string, PR[]>();
  for (const pr of open.filter((p) => sameRepository(gh, p)))
    branches.set(pr.head.ref, [...(branches.get(pr.head.ref) ?? []), pr]);
  const allowedTarget = (ref: string) =>
    gh.config!.merge.allowedBases.includes(ref) &&
    !gh.config!.merge.protectedBranches.includes(ref) &&
    ref !== gh.config!.release.target;
  const targetFor = (pr: PR, seen = new Set<number>()): string | undefined => {
    if (seen.has(pr.number) || !prs.has(pr.number)) return;
    seen.add(pr.number);
    const native = graph.native.get(pr.number);
    if (native) return allowedTarget(native.base.ref) ? native.base.ref : undefined;
    if (allowedTarget(pr.base.ref)) return pr.base.ref;
    const parents = branches.get(pr.base.ref) ?? [];
    if (parents.length === 1) return targetFor(parents[0]!, seen);
  };
  for (const pr of candidates) {
    const target = targetFor(pr);
    if (target) graph.targets.set(pr.number, target);
    else graph.problems.set(pr.number, 'Stack暂停：最终目标分支不明确');
    for (const parent of branches.get(pr.base.ref) ?? []) connect(pr.number, parent.number);
    if ((branches.get(pr.head.ref)?.length ?? 0) > 1) graph.problems.set(pr.number, 'Stack暂停：同一分支存在多个 PR');
    if (pr.stack != null && !graph.native.has(pr.number)) graph.problems.set(pr.number, '正在等待Stack同步');
    try {
      const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + pr.head.ref });
      if (ref.object.sha !== pr.head.sha) graph.problems.set(pr.number, '正在等待HEAD同步');
    } catch (e) {
      if (retryRead(e)) throw e;
      graph.problems.set(pr.number, 'Stack暂停：源分支已删除或无法读取');
    }
  }
  for (const stack of stacks) {
    const active = stack.pull_requests.filter((p) => !p.merged_at);
    const bad =
      active.some((p) => p.state !== 'open' || !prs.has(p.number)) ||
      new Set(memberNumbers(stack)).size !== stack.pull_requests.length;
    for (const [index, member] of active.entries()) {
      const pr = prs.get(member.number);
      if (!pr) continue;
      if (index) connect(active[index - 1]!.number, pr.number);
      if (
        bad ||
        member.head.sha !== pr.head.sha ||
        member.head.ref !== pr.head.ref ||
        pr.base.ref !== (index ? active[index - 1]!.head.ref : stack.base.ref)
      )
        graph.problems.set(pr.number, 'Stack暂停：状态未同步或下层 PR 已关闭');
    }
  }
  const groups = new Map<string, PR[]>();
  for (const pr of candidates) {
    const target = graph.targets.get(pr.number);
    if (target) groups.set(target, [...(groups.get(target) ?? []), pr]);
  }
  const ancestors = new Map(candidates.map((pr) => [pr.number, new Set<number>()]));
  for (const [target, members] of groups) {
    const included = new Set<number>();
    let targetSha: string | undefined;
    try {
      const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + target });
      const sha = z.string().min(1).parse(ref.object.sha);
      targetSha = sha;
      graph.targetHeads.set(target, sha);
      for (const pr of members) {
        const r = await relation(gh, sha, pr.head.sha);
        if (r.status === 'behind' || r.status === 'identical') included.add(pr.number);
      }
    } catch (e) {
      if (retryRead(e)) throw e;
      for (const pr of members) graph.problems.set(pr.number, 'Stack失败：目标分支或提交历史不可读');
    }
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!,
          b = members[j]!;
        try {
          const compared = await relation(gh, a.head.sha, b.head.sha),
            r = compared.status;
          if (r === 'identical') {
            connect(a.number, b.number);
            for (const pr of [a, b]) graph.problems.set(pr.number, 'Stack暂停：多个 PR 指向同一 HEAD');
          } else if (r === 'ahead' && !included.has(a.number)) {
            ancestors.get(b.number)!.add(a.number);
            connect(a.number, b.number);
          } else if (r === 'behind' && !included.has(b.number)) {
            ancestors.get(a.number)!.add(b.number);
            connect(a.number, b.number);
          } else if (r === 'diverged' && targetSha) {
            const shared = await relation(gh, targetSha, compared.merge_base_commit.sha);
            if (shared.status !== 'behind' && shared.status !== 'identical') {
              connect(a.number, b.number);
              for (const pr of [a, b]) graph.problems.set(pr.number, 'Stack暂停：共享未合入历史，HEAD 已分叉');
            }
          }
        } catch (e) {
          if (retryRead(e)) throw e;
          connect(a.number, b.number);
          for (const pr of [a, b]) graph.problems.set(pr.number, 'Stack暂停：祖先关系不明确');
        }
      }
  }
  for (const pr of candidates) {
    const possible = [...ancestors.get(pr.number)!];
    const nearest = possible.filter((parent) => !possible.some((other) => ancestors.get(other)!.has(parent)));
    if (nearest.length === 1) graph.parents.set(pr.number, nearest[0]!);
    if (nearest.length > 1) graph.problems.set(pr.number, 'Stack暂停：存在多个直接父 PR');
    if (graph.targets.has(pr.number) && pr.base.ref !== graph.targets.get(pr.number)) {
      const parent = graph.parents.get(pr.number);
      if (!parent || prs.get(parent)!.head.ref !== pr.base.ref)
        graph.problems.set(pr.number, 'Stack暂停：Base 与直接父 PR 不一致');
    }
  }
  const children = new Map<number, number[]>();
  for (const [child, parent] of graph.parents) children.set(parent, [...(children.get(parent) ?? []), child]);
  for (const [parent, rows] of children) if (rows.length > 1) graph.problems.set(parent, 'Stack暂停：依赖图分叉');
  const visited = new Set<number>();
  for (const pr of candidates) {
    if (visited.has(pr.number)) continue;
    const members: number[] = [],
      pending = [pr.number];
    while (pending.length) {
      const number = pending.pop()!;
      if (visited.has(number)) continue;
      visited.add(number);
      members.push(number);
      pending.push(...links.get(number)!);
    }
    members.sort((a, b) => (ancestors.get(a)!.has(b) ? 1 : ancestors.get(b)!.has(a) ? -1 : a - b));
    const problem = members.map((n) => graph.problems.get(n)).find(Boolean);
    if (problem) for (const number of members) graph.problems.set(number, problem);
    graph.components.push(members);
  }
  return graph;
}
