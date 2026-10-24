import { z } from 'zod';
import type { GitHub } from './github';
import { Denied, type PR } from './types';

const summary = z.object({
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
  id: z.number().int().positive().optional(), number: z.number().int().positive().optional(),
  size: z.number().int().positive().optional(), position: z.number().int().positive().optional()
});
const stack = z.object({
  id: z.number().int().positive(), number: z.number().int().positive(), base: z.object({ ref: z.string().min(1) }),
  pull_requests: z.array(z.object({
    number: z.number().int().positive(), state: z.enum(['open', 'closed']), merged_at: z.string().nullable(),
    head: z.object({ ref: z.string().min(1), sha: z.string().min(1) })
  })).min(1)
});
export interface StackInfo { target: string; fingerprint: string; detail?: string; waiting: number[] }

export async function stackFor(gh: GitHub, pr: PR): Promise<StackInfo> {
  const ordinary = { target: pr.base.ref, fingerprint: JSON.stringify([pr.head.sha, pr.head.ref, pr.base.ref, pr.base.sha, pr.base.repo.full_name]), waiting: [] };
  if (pr.stack == null) return ordinary;
  try {
    const hint = summary.parse(pr.stack);
    // Never infer ancestry from branch names. The official list is ordered bottom to top.
    const rows = await gh.list('GET /repos/{owner}/{repo}/stacks', { pull_request: pr.number }, undefined, true);
    if (rows.length !== 1) throw new Error('Expected one stack');
    const current = stack.parse(rows[0]), members = current.pull_requests;
    const index = members.findIndex(p => p.number === pr.number), member = members[index];
    if (!member || new Set(members.map(p => p.number)).size !== members.length ||
      hint.id !== undefined && hint.id !== current.id || hint.number !== undefined && hint.number !== current.number ||
      hint.base.ref !== current.base.ref || hint.size !== undefined && hint.size !== members.length ||
      hint.position !== undefined && hint.position !== index + 1 ||
      member.head.sha !== pr.head.sha || member.head.ref !== pr.head.ref || member.state !== pr.state ||
      pr.head.repo?.full_name.toLowerCase() !== gh.repo.toLowerCase() || pr.base.repo.full_name.toLowerCase() !== gh.repo.toLowerCase()) throw new Error('Inconsistent stack');
    const waiting = members.slice(0, index).filter(p => !p.merged_at).map(p => p.number);
    const parent = waiting.length ? members[index - 1]!.head.ref : current.base.ref;
    if (pr.base.ref !== parent) throw new Error('Stack is being updated');
    return {
      target: current.base.ref, waiting,
      detail: `Stack #${current.number} · 位置 ${index + 1}/${members.length} · 最终目标 ${current.base.ref} · 直接父分支 ${pr.base.ref}`,
      fingerprint: JSON.stringify([ordinary.fingerprint, hint, current])
    };
  } catch (e) {
    gh.audit('stack', 'unverified', { number: pr.number, message: e instanceof Error ? e.message : 'Invalid stack' });
    throw new Denied('无法可靠核实 Stack 状态。请等待 GitHub 更新 Stack 后重试；Piper 不会合并本次请求。');
  }
}
