import { z } from 'zod';
import { matches, type Config } from './config';
import type { GitHub } from './github';
import { Denied, sha256, type Gate, type Metadata, type PR, type PRState } from './types';

export const workflowLabels = ['rfr', 'ready', 'integrated', 'auto'];
export interface ChangedFile { filename: string; previous_filename?: string }
export function matchingRules(config: Config, pr: PR, files: ChangedFile[]) {
  return config.labels.filter(rule => rule.titlePrefixes.some(p => pr.title.toLowerCase().startsWith(p.toLowerCase())) || rule.branches.some(p => matches(p, pr.head.ref)) || rule.files.some(p => files.some(f => matches(p, f.filename) || (f.previous_filename && matches(p, f.previous_filename)))));
}
export function reviewPolicy(config: Config, pr: PR, files: ChangedFile[], metadata: Metadata = {}) {
  const rules = matchingRules(config, pr, files);
  const modulePool = rules.flatMap(r => r.reviewers);
  return {
    rules,
    pool: [...new Map((modulePool.length ? modulePool : config.reviewers.pool).map(p => [p.toLowerCase(), p])).values()],
    count: Math.max(config.reviewers.count, ...rules.map(r => r.reviewerCount ?? 0)),
    minimum: Math.max(config.merge.minApprovals, metadata.requiredReviews ?? 0, ...rules.map(r => r.minApprovals ?? 0)),
    highRisk: rules.some(r => r.highRisk || config.merge.highRiskLabels.includes(r.name))
  };
}

// Bound label mutations while allowing the usual phase transition in one refresh.
export async function syncLabels(gh: GitHub, pr: PR, state: PRState, files: ChangedFile[], gate?: Gate): Promise<boolean> {
  const records = await gh.records(pr.number);
  const previous = records.filter(r => r.key.startsWith('labels-owned:')).at(-1);
  const managed = new Set(previous ? z.array(z.string().min(1).max(50)).max(1000).parse(previous.value) : []);
  const timeline = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { issue_number: pr.number });
  const overrides = new Map(Object.entries(state.metadata.labels ?? {}));
  for (const event of timeline) {
    if (!['labeled', 'unlabeled'].includes(event.event) || !event.label?.name || !event.actor?.login || event.actor.type === 'Bot' || event.actor.login === gh.env.BOT_LOGIN) continue;
    const name = event.label.name as string, key = name.toLowerCase(), old = overrides.get(key);
    if (!old || Date.parse(event.created_at) >= Date.parse(old.at)) overrides.set(key, { name, mode: event.event === 'labeled' ? 'add' : 'remove', at: event.created_at });
  }
  const desired = new Set(matchingRules(gh.config!, pr, files).map(r => r.name));
  for (const [key, decision] of overrides) {
    if (workflowLabels.includes(key)) continue;
    if (decision.mode !== 'auto') for (const name of desired) { if (name.toLowerCase() === key) desired.delete(name); }
    if (decision.mode === 'add') desired.add(decision.name);
  }
  if (pr.merged) desired.add('integrated');
  else if (pr.state === 'open') {
    if (!pr.draft) desired.add('rfr');
    if (gate?.ready) desired.add('ready');
    if (state.integration === 'requested' && gate?.autoRequestValid !== false) desired.add('auto');
  }
  const current = new Map(pr.labels.map(l => [l.name.toLowerCase(), l.name]));
  const wanted = new Set([...desired].map(n => n.toLowerCase()));
  const additions = [...desired].filter(n => !current.has(n.toLowerCase()));
  let budget = 4;
  if (additions.length) {
    const definitions = await gh.list('GET /repos/{owner}/{repo}/labels');
    const missing = additions.filter(n => !definitions.some(d => d.name.toLowerCase() === n.toLowerCase()));
    for (const name of missing.slice(0, budget)) {
      await gh.write('label-definition:' + name, 'POST /repos/{owner}/{repo}/labels', { name, color: (await sha256(name)).slice(0, 6), description: workflowLabels.includes(name) ? 'Piper 协作阶段' : 'Piper 仓库配置标签' }, async () => (await gh.list('GET /repos/{owner}/{repo}/labels')).find(d => d.name.toLowerCase() === name.toLowerCase()));
    }
    if (missing.length > budget) return !gh.dryRun;
    budget -= missing.length;
  }
  const owned = new Set([...managed, ...additions.map(n => n.toLowerCase()), ...workflowLabels]);
  if ([...owned].some(n => !managed.has(n))) await gh.record(pr.number, 'labels-owned:' + await sha256(gh.job), [...owned]);
  await gh.setLabels(pr.number, additions, 'label-sync:' + gh.job);
  const removals = [...current].filter(([key]) => owned.has(key) && !wanted.has(key)).map(([, name]) => name);
  for (const name of removals.slice(0, budget)) {
    await gh.write('label-cleanup:' + gh.job + ':' + name, 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { issue_number: pr.number, name }, async () => {
      const labels = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', { issue_number: pr.number });
      return labels.some(l => l.name.toLowerCase() === name.toLowerCase()) ? undefined : labels;
    });
  }
  return removals.length > budget && !gh.dryRun;
}

export function assertManualLabel(name: string) {
  if (workflowLabels.includes(name.toLowerCase())) throw new Denied('rfr、ready、auto 和 integrated 是 Piper 维护的协作阶段标签，根据实际状态计算，不能通过 /label 手动修改。');
}
