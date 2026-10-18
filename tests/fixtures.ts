import { vi } from 'vitest';
import { GitHub, type Requester } from '../src/github';
import { parseConfig } from '../src/config';
import type { Env, Job, PR } from '../src/types';

export const repo = 'NEUP-Net-Depart/Pioneer-appointment-system';
export function testEnv(overrides: Partial<Env> = {}): Env {
  return { TASKS: { send: vi.fn(async () => undefined) } as unknown as Queue<Job>, ENVIRONMENT: 'production', APP_ID: '1', APP_PRIVATE_KEY: 'unused', WEBHOOK_SECRET: 'test-secret', ADMIN_TOKEN: 'a'.repeat(40), BOT_LOGIN: 'piper[bot]', ALLOWED_REPOSITORIES: repo, DRY_RUN: 'false', EMERGENCY_STOP: 'false', STOPPED_REPOSITORIES: '', ORG_DEFAULTS: '{"merge":{"trustedCheckAppIds":[1]}}', PUBLIC_URL: 'https://piper.example.test', ...overrides };
}
export function pull(overrides: Partial<PR> = {}): PR {
  return { number: 1, title: 'fix: repair booking', body: '', state: 'open', draft: false, user: { login: 'alice', type: 'User' }, head: { sha: 'abc123', ref: 'fix/booking', repo: { full_name: repo } }, base: { sha: 'base123', ref: 'dev', repo: { full_name: repo } }, merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: 'clean', requested_reviewers: [], labels: [], ...overrides };
}
export class FakeGitHub implements Requester {
  pr = pull();
  comments: any[] = [];
  reviews: any[] = [{ id: 1, user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: 'abc123', submitted_at: new Date().toISOString() }];
  files: any[] = [{ filename: 'src/app.ts' }];
  runs: any[] = [{ id: 1, name: 'verify', head_sha: 'abc123', status: 'completed', conclusion: 'success', app: { id: 1 } }];
  statuses: any[] = [];
  permissions: Record<string, string> = { alice: 'write', bob: 'write', carol: 'maintain', mallory: 'read' };
  calls: { route: string; args: any }[] = [];
  config = 'enabled: true\ndryRun: false\nreviewers:\n  count: 0\n';
  issueHistory: any[] = [];
  timeline: any[] = [];
  repoLabels: any[] = ['bug', 'documentation', 'rfr', 'ready', 'integrated', 'auto'].map(name => ({ name }));
  tags = new Map<string, string>();
  releases: any[] = [];
  workflows: any[] = [];
  workflowJobs: any[] = [{ name: 'release', head_sha: 'merge123', status: 'completed', conclusion: 'success' }];
  prs: any[] = [];
  extra?: (route: string, args: any) => Promise<any | undefined>;
  failAfterComment = false;
  async request(route: string, args: any = {}): Promise<{ data: any }> {
    this.calls.push({ route, args });
    if (this.extra) { const value = await this.extra(route, args); if (value !== undefined) return { data: value }; }
    if (route === 'GET /repos/{owner}/{repo}') return { data: { full_name: repo, default_branch: 'main', private: false } };
    if (route === 'GET /repos/{owner}/{repo}/installation') return { data: { id: 1 } };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: { number: this.pr.number, user: this.pr.user, pull_request: {} } };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline') return { data: this.timeline };
    if (route.includes('/collaborators/{username}/permission')) return { data: { permission: this.permissions[args.username] ?? 'none' } };
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') return { data: { type: 'file', encoding: 'base64', content: btoa(this.config), size: this.config.length, sha: 'config123' } };
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(this.pr) };
    if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') { this.pr.body = args.body; return { data: structuredClone(this.pr) }; }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') return { data: this.files };
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') return { data: this.reviews };
    if (route.endsWith('/check-runs')) return { data: { check_runs: this.runs } };
    if (route.endsWith('/statuses')) return { data: this.statuses };
    if (route === 'GET /repos/{owner}/{repo}/issues') return { data: this.issueHistory };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: this.comments.filter(x => x.issue_number === args.issue_number) };
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      const comment = { id: Math.max(0, ...this.comments.map(c => c.id)) + 1, created_at: new Date().toISOString(), body: args.body, issue_number: args.issue_number, user: { login: 'piper[bot]', type: 'Bot' } };
      this.comments.push(comment);
      if (this.failAfterComment) { this.failAfterComment = false; throw new Error('Connection lost after server committed'); }
      return { data: comment };
    }
    if (route === 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}') return { data: this.comments.find(c => c.id === args.comment_id) };
    if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') { const comment = this.comments.find(c => c.id === args.comment_id); comment.body = args.body; return { data: comment }; }
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/labels') return { data: this.pr.labels };
    if (route === 'GET /repos/{owner}/{repo}/labels') return { data: this.repoLabels };
    if (route === 'POST /repos/{owner}/{repo}/labels') { this.repoLabels.push({ name: args.name }); return { data: { name: args.name } }; }
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') { this.pr.labels.push(...args.labels.map((name: string) => ({ name }))); return { data: this.pr.labels }; }
    if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') { this.pr.labels = this.pr.labels.filter(x => x.name !== args.name); return { data: this.pr.labels }; }
    if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers') {
      for (const login of args.reviewers) { this.pr.requested_reviewers.push({ login }); this.timeline.push({ id: this.timeline.length + 1, event: 'review_requested', requested_reviewer: { login }, created_at: new Date().toISOString() }); }
      return { data: this.pr };
    }
    if (route === 'DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers') { this.pr.requested_reviewers = this.pr.requested_reviewers.filter(x => !args.reviewers.includes(x.login)); return { data: this.pr }; }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits') return { data: [{ commit: { author: { name: 'Alice', email: 'alice@example.com' } } }] };
    if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge') { this.pr.merged = true; this.pr.state = 'closed'; this.pr.merged_at = new Date().toISOString(); this.pr.merge_commit_sha = 'merge123'; return { data: { merged: true, sha: 'merge123' } }; }
    if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
      if (args.ref.startsWith('heads/')) return { data: { object: { sha: args.ref === 'heads/dev' ? 'abc123' : 'base123' } } };
      const sha = this.tags.get(args.ref.replace('tags/', ''));
      if (!sha) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: { object: { sha, type: 'commit' } } };
    }
    if (route === 'POST /repos/{owner}/{repo}/git/refs') { this.tags.set(args.ref.replace('refs/tags/', ''), args.sha); return { data: { object: { sha: args.sha } } }; }
    if (route === 'GET /repos/{owner}/{repo}/tags') return { data: [...this.tags.keys()].map(name => ({ name })) };
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { status: 'ahead', ahead_by: 1, commits: [{ sha: 'abc123', author: { login: 'alice' }, commit: { author: { name: 'Alice' }, message: 'fix booking' } }] } };
    if (route === 'GET /repos/{owner}/{repo}/pulls') {
      const prs = [...new Map([this.pr, ...this.prs].map(p => [p.number,p])).values()];
      return { data: prs.filter(p => (!args.state || args.state === 'all' || p.state === args.state) && (!args.head || p.head.ref === args.head.split(':').slice(1).join(':')) && (!args.base || p.base.ref === args.base)).map(p => ({ ...p, updated_at: new Date().toISOString() })) };
    }
    if (route === 'POST /repos/{owner}/{repo}/pulls') { const created = { ...this.pr, number: 1, title: args.title, body: args.body, user: { login: 'piper[bot]', type: 'Bot' }, head: { ...this.pr.head, ref: args.head }, base: { ...this.pr.base, ref: args.base } }; this.pr = created; this.prs.push(created); return { data: created }; }
    if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') return { data: { parents: [{ sha: 'base123' }, { sha: 'abc123' }] } };
    if (route.includes('/actions/workflows/')) return { data: { workflow_runs: this.workflows } };
    if (route.includes('/attempts/') && route.endsWith('/jobs')) return { data: { jobs: this.workflowJobs } };
    if (route === 'GET /repos/{owner}/{repo}/releases/tags/{tag}') {
      const release = this.releases.find(r => r.tag_name === args.tag);
      if (!release) throw Object.assign(new Error('not found'), { status: 404 }); return { data: release };
    }
    if (route === 'POST /repos/{owner}/{repo}/releases') { const r = { ...args, id: 1, author: { login: 'piper[bot]' } }; this.releases.push(r); return { data: r }; }
    throw new Error(`Unexpected GitHub request: ${route}`);
  }
  writes() { return this.calls.filter(x => !x.route.startsWith('GET ')); }
}
export async function fixture(config = '', overrides: Partial<Env> = {}) {
  const environment = testEnv(overrides), api = new FakeGitHub();
  const gh = new GitHub(environment, repo, 'test-job', api);
  gh.config = parseConfig(environment.ORG_DEFAULTS, 'enabled: true\ndryRun: false\n' + config);
  gh.commandOrder = 1;
  return { env: environment, api, gh };
}
