export interface Env {
  TASKS: Queue<Job>;
  COORDINATORS?: DurableObjectNamespace;
  ENVIRONMENT: 'production';
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  BOT_LOGIN: string;
  ALLOWED_REPOSITORIES: string;
  DRY_RUN: string;
  EMERGENCY_STOP: string;
  STOPPED_REPOSITORIES: string;
  ORG_DEFAULTS: string;
  PUBLIC_URL: string;
}
export interface Job {
  id: string; repo: string; installation: number;
  kind: 'reconcile' | 'status' | 'notice' | 'labels' | 'scan' | 'release' | 'command' | 'welcome' | 'merge-poll';
  failures?: number;
  number?: number; commentId?: number; bodyHash?: string; actor?: string;
  time: string;
  includeClosed?: boolean;
  checkName?: string;
  head?: string;
  branch?: string;
  workflow?: string;
  baseChanged?: boolean;
  configChanged?: boolean;
  closedSince?: string;
  syncOnly?: boolean;
  repository?: boolean;
}
export interface PR {
  stack?: { base: { ref: string; sha: string }; size?: number; position?: number; id?: number; number?: number } | null;
  number: number; title: string; body: string | null; state: string; draft: boolean;
  user: { login: string; type: string }; head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  merged: boolean; merge_commit_sha: string | null; mergeable: boolean | null; mergeable_state: string;
  merged_at?: string | null;
  author_association?: string; requested_reviewers: { login: string }[];
  labels: { name: string }[];
}
export interface PRState {
  merge?: import('./merging').MergeState;
  metadata: Metadata;
  integrate_head: string | null; integrate_actor: string | null;
  integration: 'none' | 'requested' | 'cancelled' | 'outdated';
  integrate_mode: 'manual' | 'auto' | null;
  integrate_job: string | null;
  release_job?: string;
  release_actor?: string;
  welcomes: { kind: 'pr' | 'merged'; message: string }[];
}
export interface Identity { name: string; email: string }
export interface Metadata { summary?: string; author?: Identity; contributors?: Identity[]; tag?: string; requiredReviews?: number; labels?: Record<string, { name: string; mode: 'add' | 'remove' | 'auto'; at: string }> }
export interface Review { id: number; user: { login: string; type: string }; state: string; commit_id: string; submitted_at: string }
export interface Progress { name: string; ready: boolean; detail: string; action?: string; owner?: '作者' | '审查者' | '维护者' | '等待' }
export interface Gate { stack?: import('./stacks').StackInfo; ready: boolean; reasons: string[]; reviewers: string[]; highRisk: boolean; progress: Progress[]; outdatedReviewers?: string[]; autoRequestValid?: boolean; reviewDetails?: { login: string; sha: string; state: string }[]; labelRules?: { name: string; reason: string; minimum: number; reviewers: string[] }[] }
export class Denied extends Error {}
export class Retryable extends Error {}
export const epoch = () => Math.floor(Date.now() / 1000);
export const names = (value: string) => value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
export const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(x => x.toString(16).padStart(2, '0')).join('');
export const safeText = (s: string) => s.replace(/@/g, '@\u200b').replace(/<!--/g, '&lt;!--');
export const statusCode = (e: unknown) => typeof e === 'object' && e && 'status' in e ? Number(e.status) : 0;
