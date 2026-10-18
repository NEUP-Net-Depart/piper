import { z } from 'zod';
import { parseDocument } from 'yaml';
import { Denied, names, type Env } from './types';

const text = z.string().max(10000);
const login = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/);
export const branch = z.string().min(1).max(150).refine(x => !/[\s~^:?*[\\]/.test(x) && !x.includes('..') && !x.includes('@{') && !x.includes('//') && !x.endsWith('.lock') && !/[/.]$/.test(x) && !x.startsWith('/') && x.split('/').every(p => !p.startsWith('.')));
const pattern = z.string().min(1).max(200);
const welcomeDefaults = {
  issue: '感谢反馈。请按 Issue 模板补充问题信息。',
  pr: '',
  merged: '感谢贡献。',
  image: '',
  guide: 'https://github.com/NEUP-Net-Depart/Pioneer-appointment-system/issues/39'
};
export const configSchema = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  welcome: z.object({
    issue: text.default(welcomeDefaults.issue),
    pr: text.default(welcomeDefaults.pr),
    merged: text.default(welcomeDefaults.merged),
    image: z.union([z.literal(''), z.string().url().regex(/^https:\/\/[^\s<>"()]+$/), z.string().regex(/^\/assets\/[A-Za-z0-9_.-]+$/)]).default(welcomeDefaults.image),
    guide: z.string().url().default(welcomeDefaults.guide)
  }).strict().default(welcomeDefaults),
  labels: z.array(z.object({ name: z.string().min(1).max(50), titlePrefixes: z.array(pattern).default([]), branches: z.array(pattern).default([]), files: z.array(pattern).default([]), reviewers: z.array(login).max(30).default([]), reviewerCount: z.number().int().min(0).max(10).optional(), minApprovals: z.number().int().min(1).max(10).optional(), highRisk: z.boolean().default(false) }).strict()).max(50).default([]),
  reviewers: z.object({ pool: z.array(login).max(30).default([]), count: z.number().int().min(0).max(10).default(1), remindHours: z.number().min(1).max(168).default(24), rotateHours: z.number().min(2).max(336).default(48) }).strict().default({ pool: [], count: 1, remindHours: 24, rotateHours: 48 }),
  merge: z.object({
    requiredChecks: z.array(z.string().min(1).max(100)).min(1).max(30).default(['verify']),
    trustedCheckAppIds: z.array(z.number().int().positive()).default([]),
    minApprovals: z.number().int().min(1).max(10).default(1),
    auto: z.boolean().default(false),
    allowedBases: z.array(branch).min(1).default(['dev']),
    highRiskFiles: z.array(pattern).default(['.github/**', 'migrations/**', '**/migrations/**', '.piper.yml']),
    highRiskLabels: z.array(z.string()).default(['security', 'high-risk']),
    protectedBranches: z.array(branch).default(['main'])
  }).strict().default({ requiredChecks: ['verify'], trustedCheckAppIds: [], minApprovals: 1, auto: false, allowedBases: ['dev'], highRiskFiles: ['.github/**', 'migrations/**', '**/migrations/**', '.piper.yml'], highRiskLabels: ['security', 'high-risk'], protectedBranches: ['main'] }),
  backport: z.object({ enabled: z.boolean().default(false), targets: z.array(branch).max(20).default([]), maxFiles: z.number().int().min(1).max(100).default(50) }).strict().default({ enabled: false, targets: [], maxFiles: 50 }),
  release: z.object({
    enabled: z.boolean().default(false), source: branch.default('dev'), target: branch.default('main'),
    timezone: z.string().refine(x => { try { new Intl.DateTimeFormat('en', { timeZone: x }); return true; } catch { return false; } }).default('Asia/Shanghai'),
    weekday: z.number().int().min(0).max(6).default(4), hour: z.number().int().min(0).max(23).default(18),
    version: z.enum(['patch','minor','date']).default('patch'), initialVersion: z.string().regex(/^v\d+\.\d+\.\d+$/).default('v0.1.0'),
    deploymentWorkflow: z.string().regex(/^[\w.-]+\.ya?ml$/).default('ci.yml'),
    deploymentJob: z.string().min(1).max(100).default('release'),
    requiredChecks: z.array(z.string().min(1)).min(1).default(['verify']),
    minApprovals: z.number().int().min(1).max(10).default(1)
  }).strict().default({ enabled: false, source: 'dev', target: 'main', timezone: 'Asia/Shanghai', weekday: 4, hour: 18, version: 'patch', initialVersion: 'v0.1.0', deploymentWorkflow: 'ci.yml', deploymentJob: 'release', requiredChecks: ['verify'], minApprovals: 1 })
}).strict().superRefine((c, ctx) => {
  if (c.reviewers.rotateHours <= c.reviewers.remindHours) ctx.addIssue({ code: 'custom', message: 'rotateHours must exceed remindHours' });
  if (c.release.source === c.release.target) ctx.addIssue({ code: 'custom', message: 'Release source and target must differ' });
  if (new Set(c.reviewers.pool.map(x => x.toLowerCase())).size !== c.reviewers.pool.length) ctx.addIssue({ code: 'custom', message: 'Duplicate reviewers' });
  const reserved = ['rfr', 'ready', 'integrated', 'auto'];
  if (c.labels.some(r => reserved.includes(r.name.toLowerCase()))) ctx.addIssue({ code: 'custom', message: 'Workflow labels are managed by Piper' });
  if (new Set(c.labels.map(r => r.name.toLowerCase())).size !== c.labels.length) ctx.addIssue({ code: 'custom', message: 'Duplicate labels' });
});
export type Config = z.infer<typeof configSchema>;
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Denied('Unsafe configuration key');
    const old = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && old && typeof old === 'object' && !Array.isArray(old) ? merge(old as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}
export function parseConfig(defaults: string, yaml: string): Config {
  if (yaml.length > 65536) throw new Denied('Configuration exceeds 64 KiB');
  const doc = parseDocument(yaml, { uniqueKeys: true });
  if (doc.errors.length) throw new Denied('Invalid YAML: ' + doc.errors[0]?.message);
  const override: unknown = doc.toJS({ maxAliasCount: 20 }) ?? {};
  if (typeof override !== 'object' || Array.isArray(override)) throw new Denied('Configuration must be a mapping');
  const base: unknown = JSON.parse(defaults || '{}');
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Denied('Organization defaults must be a mapping');
  return configSchema.parse(merge(merge(configSchema.parse({}) as unknown as Record<string, unknown>, base as Record<string, unknown>), override as Record<string, unknown>));
}
export function matches(pattern: string, path: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$').test(path);
}
export function allowed(env: Env, repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && names(env.ALLOWED_REPOSITORIES).includes(repo.toLowerCase());
}
