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
    throw new Denied('GitHub Compare 返回了不一致的祖先关系。');
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
  if (candidates.length > MAX_STACK_PRS)
    throw new Denied(`待核验 PR 超过 ${MAX_STACK_PRS} 条，已暂停自动 Stack；请维护者缩小待处理范围。`);
  if (new Set(open.map((p) => p.number)).size !== open.length) throw new Denied('PR 列表不完整或重复。');
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
      throw new Denied('无法读取 GitHub 原生 Stack。请维护者确认仓库支持 Stack 且 App 具备 Pull requests 读取权限。', {
        cause: e,
      });
    throw e;
  }
  for (const stack of stacks)
    for (const n of memberNumbers(stack)) {
      if (graph.native.has(n)) throw new Denied('同一 PR 出现在多个 Stack 中。');
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
    else graph.problems.set(pr.number, '无法唯一确认最终目标分支。请维护者检查 PR 的 Base 和下层 PR 状态。');
    for (const parent of branches.get(pr.base.ref) ?? []) connect(pr.number, parent.number);
    if ((branches.get(pr.head.ref)?.length ?? 0) > 1)
      graph.problems.set(pr.number, '同一源分支对应多个 PR，无法唯一确认依赖。请维护者检查重复 PR。');
    if (pr.stack != null && !graph.native.has(pr.number))
      graph.problems.set(pr.number, 'GitHub 尚未返回完整 Stack。请等待 Stack 状态更新。');
    try {
      const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + pr.head.ref });
      if (ref.object.sha !== pr.head.sha)
        graph.problems.set(pr.number, '源分支与 PR 的 HEAD 尚未同步，等待 GitHub 更新后重新核验。');
    } catch (e) {
      if (retryRead(e)) throw e;
      graph.problems.set(pr.number, '源分支已删除或无法读取，已暂停自动 Stack。请维护者检查分支和 App 权限。');
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
        graph.problems.set(
          pr.number,
          'Stack 正在更新，或下层 PR 已关闭、分支已改变。请等待 GitHub Restack；失败时由维护者检查 Stack。',
        );
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
      for (const pr of members)
        graph.problems.set(pr.number, '无法核实目标分支或提交历史。请维护者检查分支是否存在及 App 读取权限。');
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
            for (const pr of [a, b])
              graph.problems.set(pr.number, '多个 PR 指向同一提交，无法唯一确认依赖。请维护者检查重复 PR。');
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
              for (const pr of [a, b])
                graph.problems.set(
                  pr.number,
                  'PR 共享尚未合入目标分支的历史，但当前 HEAD 已分叉。请维护者确认依赖，Piper 已暂停自动 Stack。',
                );
            }
          }
        } catch (e) {
          if (retryRead(e)) throw e;
          connect(a.number, b.number);
          for (const pr of [a, b])
            graph.problems.set(pr.number, '无法证明唯一的提交祖先关系。请维护者检查 Git 历史和 App 读取权限。');
        }
      }
  }
  for (const pr of candidates) {
    const possible = [...ancestors.get(pr.number)!];
    const nearest = possible.filter((parent) => !possible.some((other) => ancestors.get(other)!.has(parent)));
    if (nearest.length === 1) graph.parents.set(pr.number, nearest[0]!);
    if (nearest.length > 1)
      graph.problems.set(pr.number, '存在多个直接父 PR，已暂停自动 Stack。请维护者检查合流历史。');
    if (graph.targets.has(pr.number) && pr.base.ref !== graph.targets.get(pr.number)) {
      const parent = graph.parents.get(pr.number);
      if (!parent || prs.get(parent)!.head.ref !== pr.base.ref)
        graph.problems.set(
          pr.number,
          '当前 Base 与已证明的直接父 PR 不一致。请维护者确认分支关系；Piper 会保留当前 Base。',
        );
    }
  }
  const children = new Map<number, number[]>();
  for (const [child, parent] of graph.parents) children.set(parent, [...(children.get(parent) ?? []), child]);
  for (const [parent, rows] of children)
    if (rows.length > 1) graph.problems.set(parent, '依赖图出现分叉，已暂停自动 Stack。请维护者确认各分支应如何组织。');
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
