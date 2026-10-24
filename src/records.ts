import { z } from 'zod';
import type { GitHub } from './github';
import { Denied, type PRState, type PR } from './types';
import { mergeState } from './merging';

const identity = z.object({ name: z.string().min(1).max(100).regex(/^[^<>\r\n]+$/), email: z.string().regex(/^[^\s<>@]+@[^\s<>@]+$/) }).strict();
const commandFields = { order: z.number().int().positive(), actor: z.string().min(1), head: z.string().min(1) };
// Read and ignore retired requests so existing Bot comments remain recoverable.
const retiredCommandSchema = z.object({ ...commandFields, change: z.object({ kind: z.literal('sponsor-request') }).strict() }).strict();
export const commandStateSchema = z.object({
  ...commandFields,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('summary'), value: z.string().max(6000) }),
    z.object({ kind: z.literal('author'), value: identity }),
    z.object({ kind: z.literal('contributor-add'), value: identity }),
    z.object({ kind: z.literal('contributor-remove'), value: z.string() }),
    z.object({ kind: z.literal('tag'), value: z.string().max(80) }),
    z.object({ kind: z.literal('reviewers-count'), value: z.number().int().min(1).max(10) }),
    z.object({ kind: z.literal('label'), name: z.string().min(1).max(50), mode: z.enum(['add', 'remove', 'auto']), at: z.string().datetime() }),
    z.object({ kind: z.literal('integrate'), cancelled: z.boolean(), mode: z.enum(['manual', 'auto']).optional() })
  ])
}).strict();
export type CommandState = z.infer<typeof commandStateSchema>;
export interface NativeRecord<T = unknown> { key: string; value: T; id: number; createdAt: string }
export const STATUS_MARKER = '<!-- piper:status -->';
const dataMarker = '\n\n<!-- piper:data -->\n';
export function recordMarkers(body: string): string[] {
  const records = body.split(/\r?\n/).filter(line => line.startsWith('<!-- piper-record:v1:')).map(line => line.trim());
  if (records.some(line => !/^<!-- piper-record:v1:[A-Za-z0-9+/=]+ -->$/.test(line))) throw new Denied('Malformed Piper recovery record; restore the original Bot comment before retrying');
  return records;
}
export const visibleComment = (body: string) => body.split(dataMarker)[0]!.trimEnd();
export function commentBody(visible: string, records: string[]) {
  const body = visible + (records.length ? dataMarker + [...new Set(records)].join('\n') : '');
  if (body.length > 60000) throw new Denied('Piper comment exceeds recovery storage limit; maintainer action required');
  return body;
}
const envelope = z.object({ v: z.literal(1), repo: z.string(), number: z.number().int().positive(), key: z.string().max(300), value: z.unknown() }).strict();
export function encodeRecord(repo: string, number: number, key: string, value: unknown) {
  const json = JSON.stringify({ v: 1, repo: repo.toLowerCase(), number, key, value });
  const encoded = btoa(Array.from(new TextEncoder().encode(json), x => String.fromCharCode(x)).join(''));
  if (encoded.length > 45000) throw new Denied('GitHub recovery record too large');
  return `<!-- piper-record:v1:${encoded} -->`;
}
export function decodeRecords(comment: any, bot: string, repo: string, number: number): NativeRecord[] {
  if (comment.user?.login !== bot || comment.user?.type !== 'Bot') return [];
  return recordMarkers(comment.body ?? '').flatMap(marker => {
    try {
      const encoded = marker.slice('<!-- piper-record:v1:'.length, -' -->'.length);
      const value = envelope.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)))));
      if (value.repo !== repo.toLowerCase() || value.number !== number) return [];
      return [{ key: value.key, value: value.value, id: comment.id, createdAt: comment.created_at }];
    } catch { throw new Denied('Malformed Piper recovery record; restore the original Bot comment before retrying'); }
  });
}
export async function prState(gh: GitHub, pr: PR): Promise<PRState> {
  const state: PRState = { metadata: {}, integrate_head: null, integrate_actor: null, integration: 'none', integrate_mode: null, integrate_job: null, welcomes: [] };
  const records = await gh.records(pr.number);
  state.merge = mergeState(records);
  const approval = records.find(r => r.key === 'release-approval:' + pr.head.sha)?.value as { job?: unknown; actor?: unknown } | undefined;
  if (typeof approval?.job === 'string') state.release_job = approval.job;
  if (typeof approval?.actor === 'string') state.release_actor = approval.actor;
  for (const r of records.filter(r => r.key.startsWith('welcome:'))) {
    const welcome = z.object({ kind: z.enum(['pr', 'merged']), message: z.string().max(11000) }).strict().parse(r.value);
    state.welcomes.push(welcome);
  }
  const commands = records.filter(r => r.key.startsWith('command-state:')).flatMap(r => retiredCommandSchema.safeParse(r.value).success ? [] : [{ command: commandStateSchema.parse(r.value), job: r.key.slice('command-state:'.length) }]).sort((a,b) => a.command.order - b.command.order);
  for (const { command, job } of commands) {
    const c = command.change;
    switch (c.kind) {
      case 'summary': state.metadata.summary = c.value; break;
      case 'author': state.metadata.author = c.value; break;
      case 'tag': state.metadata.tag = c.value; break;
      case 'reviewers-count': state.metadata.requiredReviews = c.value; break;
      case 'label': (state.metadata.labels ??= {})[c.name.toLowerCase()] = { name: c.name, mode: c.mode, at: c.at }; break;
      case 'contributor-add': state.metadata.contributors = [...(state.metadata.contributors ?? []).filter(a => a.email.toLowerCase() !== c.value.email.toLowerCase()), c.value]; break;
      case 'contributor-remove': state.metadata.contributors = (state.metadata.contributors ?? []).filter(a => a.email.toLowerCase() !== c.value.toLowerCase()); break;
      case 'integrate':
        state.integrate_head = !c.cancelled && command.head === pr.head.sha ? command.head : null;
        state.integrate_actor = state.integrate_head ? command.actor : null;
        state.integrate_mode = state.integrate_head ? c.mode ?? 'auto' : null;
        state.integrate_job = state.integrate_head ? job : null;
        state.integration = c.cancelled ? 'cancelled' : !state.integrate_head ? 'outdated' : state.integrate_mode === 'auto' ? 'requested' : 'none'; break;
    }
  }
  if (state.merge?.result?.status === 'failed' && (state.merge.intent.options.sha !== pr.head.sha || state.integrate_job && state.integrate_job !== state.merge.intent.key)) state.merge = undefined;
  return state;
}
