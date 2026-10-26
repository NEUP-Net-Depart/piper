import { z } from 'zod';
import type { GitHub } from './github';
import type { NativeRecord } from './records';
import type { StackInfo } from './stacks';
import { mergeState } from './merging';
import {
  dependencyGraph,
  graphComponent,
  graphSnapshot,
  nativeStackSchema,
  sameRepository,
  stackCandidate,
  type DependencyGraph,
  type NativeStack,
} from './stack-graph';
import { Denied, Retryable, sha256, statusCode, type PR } from './types';

const member = z.object({
  number: z.number().int().positive(),
  head: z.string().min(1),
  ref: z.string().min(1),
  base: z.string().min(1),
  baseEvent: z.number().int().nonnegative(),
});
const planSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    target: z.string().min(1),
    members: z.array(member).min(2),
    existing: nativeStackSchema.optional(),
    supersedes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;
const doneSchema = z.object({ id: z.number().int().positive(), number: z.number().int().positive() }).strict();
interface History {
  records: NativeRecord[];
  plan?: Plan;
  done?: z.infer<typeof doneSchema>;
}
async function historyFor(gh: GitHub, number: number): Promise<History> {
  const records = await gh.records(number);
  const saved = records.filter((r) => r.key.startsWith('stack-plan:')).at(-1);
  if (!saved) return { records };
  const plan = planSchema.parse(saved.value);
  if (
    saved.key !== 'stack-plan:' + plan.id ||
    new Set(plan.members.map((m) => m.number)).size !== plan.members.length ||
    !plan.members.some((m) => m.number === number)
  )
    throw new Denied('Stack暂停：恢复回执不一致');
  const done = records.find((r) => r.key === 'stack-done:' + plan.id);
  return { records, plan, done: done && doneSchema.parse(done.value) };
}
function expectedMembers(plan: Plan) {
  const old = plan.existing?.pull_requests ?? [];
  return [
    ...old.map((m) => ({ number: m.number, ref: m.head.ref })),
    ...plan.members
      .filter((m) => !old.some((p) => p.number === m.number))
      .map((m) => ({ number: m.number, ref: m.ref })),
  ];
}
function matchesPlan(stack: NativeStack, plan: Plan) {
  const expected = expectedMembers(plan);
  return (
    stack.base.ref === plan.target &&
    (!plan.existing || (stack.id === plan.existing.id && stack.number === plan.existing.number)) &&
    JSON.stringify(stack.pull_requests.map((m) => [m.number, m.head.ref])) ===
      JSON.stringify(expected.map((m) => [m.number, m.ref]))
  );
}
function owned(stack: NativeStack, history: History) {
  return (
    !!history.plan &&
    !!history.done &&
    history.done.id === stack.id &&
    history.done.number === stack.number &&
    matchesPlan(stack, history.plan)
  );
}
const desiredBase = (plan: Plan, index: number) => (index ? plan.members[index - 1]!.ref : plan.target);
const manual = '已管理的 Stack 被修改，已暂停自动操作，可通过 stack.enabled关闭自动管理';
const external = 'Stack暂停：监测到已有手动Stack';
const pausedMessage = (message: string) =>
  message.startsWith('Stack') || message === manual ? message : 'Stack 已暂停：' + message;
async function manualBaseEvent(gh: GitHub, number: number) {
  const events = await gh.list(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
    { issue_number: number },
    undefined,
    true,
  );
  let last = 0;
  for (const event of events)
    if (event.event === 'base_ref_changed' && !(event.actor?.login === gh.env.BOT_LOGIN && event.actor?.type === 'Bot'))
      last = Math.max(last, z.number().int().positive().parse(event.id));
  return last;
}

// Called by all merge gates, including direct commands and read-only status refreshes.
export async function dependencyFor(gh: GitHub, pr: PR): Promise<StackInfo | undefined> {
  if (!gh.config?.stack.enabled || !stackCandidate(gh, pr)) return;
  const graph = await dependencyGraph(gh),
    members = graphComponent(graph, pr.number);
  const current = graph.prs.get(pr.number);
  if (
    !current ||
    current.head.sha !== pr.head.sha ||
    current.base.ref !== pr.base.ref ||
    current.base.sha !== pr.base.sha
  )
    throw new Denied('正在等待PR或依赖图更新');
  const history = await historyFor(gh, pr.number),
    native = graph.native.get(pr.number);
  const target = graph.targets.get(pr.number) ?? history.plan?.target ?? pr.base.ref;
  let blocked = graph.problems.get(pr.number),
    owner: StackInfo['owner'] =
      blocked?.startsWith('正在等待') || blocked?.startsWith('Stack暂停：状态未同步') ? '等待' : '维护者';
  if (!blocked && history.plan && !history.done) {
    const failure = history.records.find((r) => r.key.startsWith('stack-failure:' + history.plan!.id + ':'));
    const paused = history.records.filter((r) => r.key.startsWith('stack-paused:' + history.plan!.id + ':')).at(-1);
    blocked = paused
      ? pausedMessage(z.object({ message: z.string() }).parse(paused.value).message)
      : failure
        ? 'Stack失败：github未接受'
        : '正在等待stack建立';
    owner = failure || paused ? '维护者' : '等待';
  }
  if (!blocked && history.done && (!native || !owned(native, history))) blocked = manual;
  if (!blocked && members.length > 1) {
    const sameStack = native && members.every((n) => graph.native.get(n)?.id === native.id);
    if (!sameStack) {
      const existing = members.map((n) => graph.native.get(n)).find(Boolean);
      const otherHistory =
        existing && (await historyFor(gh, existing.pull_requests.find((p) => p.state === 'open')!.number));
      const managedElsewhere = existing && otherHistory && !owned(existing, otherHistory);
      blocked = managedElsewhere
        ? external
        : gh.dryRun || gh.config.stack.dryRun
          ? '正在等待stack建立'
          : '正在建立pr Stack';
      owner = managedElsewhere ? '维护者' : '等待';
    }
  }
  const index = members.indexOf(pr.number);
  return {
    target,
    blocked,
    owner,
    waiting: members.slice(0, Math.max(0, index)),
    detail:
      members.length > 1
        ? `${members.map((n) => '#' + n).join(' → ')} · 最终目标 ${target}`
        : blocked
          ? '自动 Stack'
          : undefined,
    fingerprint: JSON.stringify([graphSnapshot(graph, members), history.plan?.id, history.done, blocked]),
  };
}

async function validatePlan(gh: GitHub, plan: Plan) {
  const graph = await dependencyGraph(gh),
    numbers = plan.members.map((m) => m.number);
  if (JSON.stringify(graphComponent(graph, numbers[0]!)) !== JSON.stringify(numbers)) throw new Denied('依赖图已变化');
  for (const [index, expected] of plan.members.entries()) {
    const pr = graph.prs.get(expected.number);
    if (
      !pr ||
      graph.problems.has(pr.number) ||
      graph.targets.get(pr.number) !== plan.target ||
      pr.head.sha !== expected.head ||
      pr.head.ref !== expected.ref ||
      ![expected.base, desiredBase(plan, index)].includes(pr.base.ref)
    )
      throw new Denied('HEAD、Base 或依赖已变化');
    if ((await manualBaseEvent(gh, pr.number)) !== expected.baseEvent) throw new Denied(manual);
    const history = await historyFor(gh, pr.number),
      merge = mergeState(history.records);
    if (merge && (!merge.result || ['unknown', 'enqueued'].includes(merge.result.status)))
      throw new Denied('下层 PR 合并结果未确认');
  }
  const natives = [
    ...new Map(
      numbers.flatMap((n) => {
        const stack = graph.native.get(n);
        return stack ? [[stack.id, stack] as const] : [];
      }),
    ).values(),
  ];
  if (natives.length > 1) throw new Denied('涉及多个 Stack');
  const native = natives[0];
  if (native && matchesPlan(native, plan)) return { graph, complete: native };
  if (plan.existing ? JSON.stringify(native) !== JSON.stringify(plan.existing) : !!native) throw new Denied(manual);
  return { graph, complete: undefined };
}
async function freshMember(gh: GitHub, plan: Plan, index: number) {
  const expected = plan.members[index]!;
  const pr = await gh.read<PR>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: expected.number });
  if (
    !sameRepository(gh, pr) ||
    pr.state !== 'open' ||
    pr.merged ||
    pr.head.sha !== expected.head ||
    pr.head.ref !== expected.ref ||
    ![expected.base, desiredBase(plan, index)].includes(pr.base.ref)
  )
    throw new Denied('PR 已变化');
  const ref = await gh.read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/' + expected.ref });
  if (ref.object.sha !== expected.head) throw new Denied('源分支 HEAD 未同步');
  if (pr.mergeable === null) throw new Retryable('正在等待Stack冲突检查');
  if (pr.mergeable !== true) throw new Denied('PR 存在冲突');
  return pr;
}
async function finishPlan(gh: GitHub, plan: Plan, stack: NativeStack) {
  for (const m of plan.members)
    await gh.record(m.number, 'stack-done:' + plan.id, { id: stack.id, number: stack.number });
}
async function applyPlan(gh: GitHub, plan: Plan) {
  // Persist the same intent in each member's existing status receipt before the first Base edit.
  for (const m of plan.members) await gh.record(m.number, 'stack-plan:' + plan.id, plan);
  const initial = await validatePlan(gh, plan);
  if (initial.complete) {
    await finishPlan(gh, plan, initial.complete);
    gh.stackRefreshes.set(plan.members[0]!.number, plan.id + ':complete');
    return;
  }
  for (let index = 1; index < plan.members.length; index++) {
    const m = plan.members[index]!,
      base = desiredBase(plan, index);
    if (plan.existing?.pull_requests.some((p) => p.number === m.number)) continue;
    if (initial.graph.prs.get(m.number)?.base.ref === base) continue;
    await gh.write(
      `stack-base:${plan.id}:${m.number}`,
      'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
      { pull_number: m.number, base },
      async () => {
        const checked = await validatePlan(gh, plan);
        if (checked.complete) return checked.graph.prs.get(m.number);
        await freshMember(gh, plan, index - 1);
        const current = await freshMember(gh, plan, index);
        await validatePlan(gh, plan);
        return current.base.ref === base ? current : undefined;
      },
    );
    gh.stackRefreshes.set(plan.members[0]!.number, plan.id + ':base:' + m.number);
    return;
  }
  const added = plan.members
    .filter((m) => !plan.existing?.pull_requests.some((p) => p.number === m.number))
    .map((m) => m.number);
  const route = plan.existing
    ? 'POST /repos/{owner}/{repo}/stacks/{stack_number}/add'
    : 'POST /repos/{owner}/{repo}/stacks';
  const result = await gh.write(
    `stack-create:${plan.id}`,
    route,
    {
      ...(plan.existing ? { stack_number: plan.existing.number } : {}),
      pull_requests: added,
    },
    async () => {
      const checked = await validatePlan(gh, plan);
      if (checked.complete) return checked.complete;
      for (let i = 0; i < plan.members.length; i++) {
        const current = await freshMember(gh, plan, i);
        if (current.base.ref !== desiredBase(plan, i)) throw new Denied('Base 链未就绪');
      }
      const final = await validatePlan(gh, plan);
      if (final.complete) return final.complete;
      if (plan.members.some((m, i) => final.graph.prs.get(m.number)?.base.ref !== desiredBase(plan, i)))
        throw new Denied('Base 链未就绪');
      return undefined;
    },
  );
  if (!result) return;
  const checked = await validatePlan(gh, plan);
  if (!checked.complete) throw new Retryable('正在等待Stack同步');
  await finishPlan(gh, plan, checked.complete);
  gh.stackRefreshes.set(plan.members[0]!.number, plan.id + ':complete');
}

async function componentPlan(gh: GitHub, graph: DependencyGraph, members: number[]) {
  const histories = new Map<number, History>();
  for (const n of members) histories.set(n, await historyFor(gh, n));
  const pending = [
    ...new Map([...histories.values()].filter((h) => h.plan && !h.done).map((h) => [h.plan!.id, h.plan!])).values(),
  ];
  if (pending.length) {
    const latest = pending.find((p) => pending.every((other) => other.id === p.id || p.supersedes.includes(other.id)));
    if (!latest) throw new Denied('恢复计划不一致');
    // New commits can resume a partially prepared chain after proving the same edges again.
    // A human Base edit is a separate instruction and must never be silently reversed.
    if (
      JSON.stringify(latest.members.map((m) => m.number)) === JSON.stringify(members) &&
      !members.some((n) => graph.problems.has(n))
    ) {
      let changed = false;
      for (const [i, m] of latest.members.entries()) {
        const pr = graph.prs.get(m.number)!;
        if (
          pr.head.ref !== m.ref ||
          graph.targets.get(m.number) !== latest.target ||
          ![m.base, desiredBase(latest, i)].includes(pr.base.ref) ||
          (await manualBaseEvent(gh, m.number)) !== m.baseEvent
        )
          return latest;
        changed ||= pr.head.sha !== m.head;
      }
      if (changed) {
        const data = {
          target: latest.target,
          members: latest.members.map((m) => ({ ...m, head: graph.prs.get(m.number)!.head.sha })),
          ...(latest.existing ? { existing: latest.existing } : {}),
          supersedes: [...latest.supersedes, latest.id],
        };
        return planSchema.parse({ ...data, id: await sha256(JSON.stringify(data)) });
      }
    }
    return latest;
  }
  if (members.some((n) => graph.problems.has(n))) return;
  const natives = [
    ...new Map(
      members.flatMap((n) => {
        const stack = graph.native.get(n);
        return stack ? [[stack.id, stack] as const] : [];
      }),
    ).values(),
  ];
  if (natives.length > 1) throw new Denied('涉及多个 Stack');
  const existing = natives[0];
  if (existing && members.every((n) => graph.native.get(n)?.id === existing.id)) return;
  if (members.length < 2) return;
  if (existing) {
    const active = existing.pull_requests.filter((p) => !p.merged_at).map((p) => p.number);
    if (
      JSON.stringify(members.slice(0, active.length)) !== JSON.stringify(active) ||
      !active.every((n) => owned(existing, histories.get(n)!))
    )
      throw new Denied(external);
  }
  for (const n of members) if (histories.get(n)!.done && !graph.native.has(n)) throw new Denied(manual);
  const data = {
    target: graph.targets.get(members[0]!)!,
    members: await Promise.all(
      members.map(async (n) => {
        const pr = graph.prs.get(n)!;
        return {
          number: n,
          head: pr.head.sha,
          ref: pr.head.ref,
          base: pr.base.ref,
          baseEvent: await manualBaseEvent(gh, n),
        };
      }),
    ),
    ...(existing ? { existing } : {}),
    supersedes: [],
  };
  return planSchema.parse({ ...data, id: await sha256(JSON.stringify(data)) });
}

// Reconciliation and integrate commands run under the shared repository coordinator.
export async function manageStacks(gh: GitHub) {
  if (!gh.config?.stack.enabled || gh.stackRefreshes.size) return;
  let graph: DependencyGraph;
  try {
    graph = await dependencyGraph(gh);
  } catch (e) {
    gh.audit('stack-discovery', 'unverified', { message: e instanceof Error ? e.message : 'Unknown failure' });
    if (!(e instanceof Denied) && !(e instanceof z.ZodError) && ![403, 404, 409, 422].includes(statusCode(e))) throw e;
    return;
  }
  for (const members of graph.components) {
    let plan: Plan | undefined;
    try {
      plan = await componentPlan(gh, graph, members);
      if (!plan) continue;
      if (gh.dryRun || gh.config.stack.dryRun) {
        gh.audit('stack', 'dry_run', {
          members,
          target: plan.target,
          bases: plan.members.map((m, i) => [m.number, desiredBase(plan!, i)]),
          append: plan.existing?.number,
        });
        continue;
      }
      await applyPlan(gh, plan);
      return;
    } catch (e) {
      gh.audit('stack', 'paused', {
        members,
        status: statusCode(e),
        message: e instanceof Error ? e.message : 'Unknown failure',
      });
      if (plan && [403, 404, 409, 422].includes(statusCode(e)))
        for (const m of plan.members)
          await gh.record(m.number, `stack-failure:${plan.id}:${statusCode(e)}`, { status: statusCode(e) });
      if (plan && e instanceof Denied && !gh.dryRun && !gh.config.stack.dryRun)
        for (const m of plan.members)
          await gh.record(m.number, `stack-paused:${plan.id}:${await sha256(e.message)}`, { message: e.message });
      if (!(e instanceof Denied) && ![403, 404, 409, 422].includes(statusCode(e))) throw e;
    }
  }
}
