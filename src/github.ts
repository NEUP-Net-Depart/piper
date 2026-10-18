import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { allowed, type Config } from './config';
import { Denied, Retryable, names, sha256, statusCode, type Env, type PR } from './types';
import { commentBody, decodeRecords, encodeRecord, recordMarkers, STATUS_MARKER, visibleComment, type NativeRecord } from './records';
import { addressUser } from './mentions';

export type Requester = { request: (route: string, parameters?: any) => Promise<{ data: any }> };
export class GitHub {
  readonly owner: string;
  readonly name: string;
  config?: Config;
  actor = 'piper';
  commandOrder = 0;
  commandName?: string;
  commandResult?: string;
  readonly ciStartupRefreshes = new Map<number, { head: string; at: number }>();
  private cacheEnabled = false;
  private readonly lists = new Map<string, Promise<any[]>>();
  private readonly observedPRs = new Map<number, string>();
  readonly requests = { reads: 0, cacheHits: 0, writes: 0 };
  constructor(readonly env: Env, readonly repo: string, readonly job: string, readonly api: Requester) {
    [this.owner, this.name] = repo.split('/') as [string, string];
  }
  async read<T = any>(route: string, args: Record<string, unknown> = {}): Promise<T> {
    this.requests.reads++;
    const scope = route.includes('{owner}') && route.includes('{repo}') ? { owner: this.owner, repo: this.name } : {};
    return (await this.api.request(route, { ...scope, ...args, request: { timeout: 20000 } })).data as T;
  }
  useReadCache() { this.cacheEnabled = true; }
  clearReadCache() { this.lists.clear(); }
  observePR(pr: PR) {
    const revision = JSON.stringify([pr.head.sha, pr.base.sha, pr.base.ref, pr.state, pr.merged]);
    if (this.observedPRs.has(pr.number) && this.observedPRs.get(pr.number) !== revision) this.clearReadCache();
    this.observedPRs.set(pr.number, revision);
    return pr;
  }
  async fresh<T>(run: () => Promise<T>): Promise<T> {
    const enabled = this.cacheEnabled;
    this.cacheEnabled = false; this.clearReadCache();
    try { return await run(); }
    finally { this.clearReadCache(); this.cacheEnabled = enabled; }
  }
  private listKey(route: string, args: Record<string, unknown>, field?: string) {
    return JSON.stringify([route, Object.entries(args).sort(([a], [b]) => a.localeCompare(b)), field ?? '']);
  }
  async list<T = any>(route: string, args: Record<string, unknown> = {}, field?: string, fresh = false): Promise<T[]> {
    if (!this.cacheEnabled || fresh) return this.readList<T>(route, args, field);
    const key = this.listKey(route, args, field);
    let pending = this.lists.get(key);
    if (pending) this.requests.cacheHits++;
    else {
      pending = this.readList(route, args, field).then(rows => structuredClone(rows));
      this.lists.set(key, pending);
      void pending.catch(() => { if (this.lists.get(key) === pending) this.lists.delete(key); });
    }
    return structuredClone(await pending) as T[];
  }
  private async readList<T>(route: string, args: Record<string, unknown>, field?: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.read<any>(route, { ...args, per_page: 100, page });
      const rows = field ? data[field] : data;
      if (!Array.isArray(rows)) throw new Error('Unexpected GitHub pagination response');
      out.push(...rows);
      if (rows.length < 100) return out;
    }
    throw new Denied('GitHub pagination limit reached; refusing incomplete evidence');
  }
  private async rememberComment(number: number, comment: any) {
    const key = this.listKey('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number });
    const cached = this.lists.get(key);
    if (!cached || !comment?.id || typeof comment.body !== 'string') return;
    const rows = structuredClone(await cached).filter(c => c.id !== comment.id);
    rows.push(structuredClone(comment));
    this.lists.set(key, Promise.resolve(rows));
  }
  async permission(login: string) {
    try { return (await this.read('GET /repos/{owner}/{repo}/collaborators/{username}/permission', { username: login })).permission as string; }
    catch (e) { if (statusCode(e) === 404) return 'none'; throw e; }
  }
  async maintainer(login: string) { return ['admin', 'maintain', 'write'].includes(await this.permission(login)); }
  get dryRun() { return this.env.DRY_RUN !== 'false' || this.config?.dryRun !== false; }
  async guard() {
    if (!allowed(this.env, this.repo) || !this.config?.enabled || stopped(this.env, this.repo)) throw new Denied('Writes disabled by repository policy or emergency stop');
  }
  audit(action: string, outcome: string, detail: unknown = {}) {
    console.log(JSON.stringify({ service: 'piper', environment: this.env.ENVIRONMENT, repo: this.repo, job: this.job, actor: this.actor, action, outcome, detail, at: new Date().toISOString() }));
  }
  async write<T = any>(key: string, route: string, args: Record<string, unknown>, reconcile: () => Promise<T | undefined>): Promise<T | null> {
    await this.guard();
    const hash = await sha256(JSON.stringify({ route, args }));
    if (this.dryRun) {
      this.audit(route, 'dry_run', { key, requestHash: hash, target: args.issue_number ?? args.pull_number ?? args.ref ?? args.tag_name });
      return null;
    }
    this.audit(route, 'intent', { key, requestHash: hash });
    try {
      const recovered = await reconcile();
      await this.guard();
      if (recovered === undefined) this.requests.writes++;
      const result = recovered ?? (await this.api.request(route, { owner: this.owner, repo: this.name, ...args, request: { timeout: 20000 } })).data as T;
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments' || route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
        const number = Number(args.issue_number);
        if (Number.isSafeInteger(number)) await this.rememberComment(number, result);
      } else this.clearReadCache();
      this.audit(route, recovered === undefined ? 'applied' : 'reconciled', { key, requestHash: hash });
      return result;
    } catch (e) {
      this.clearReadCache();
      this.audit(route, 'unconfirmed', { key, requestHash: hash, status: statusCode(e) });
      throw e;
    }
  }
  async records(number: number): Promise<NativeRecord[]> {
    const comments = await this.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number });
    const records = new Map<string, NativeRecord>();
    for (const c of comments.sort((a,b) => a.id - b.id)) {
      for (const r of decodeRecords(c, this.env.BOT_LOGIN, this.repo, number)) if (!records.has(r.key)) records.set(r.key, r);
    }
    return [...records.values()];
  }
  async getRecord<T>(number: number, key: string): Promise<T | undefined> { return (await this.records(number)).find(r => r.key === key)?.value as T | undefined; }
  async managedComment(number: number, marker: string, visible?: string, record?: { key: string; value: unknown }) {
    const comments = await this.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number });
    if (record) {
      const saved = comments.sort((a,b) => a.id - b.id).find(c => decodeRecords(c, this.env.BOT_LOGIN, this.repo, number).some(r => r.key === record.key));
      if (saved) return saved;
    }
    const matches = (c: any) => c.user?.login === this.env.BOT_LOGIN && c.user?.type === 'Bot' && c.body?.startsWith(marker);
    const existing = comments.filter(matches).sort((a,b) => a.id - b.id)[0];
    const expectedBody = existing?.body;
    const initial = marker === STATUS_MARKER ? `[查看 PR 描述中的协作进度](https://github.com/${this.repo}/pull/${number}#piper-progress)。` : `Piper · \`/${this.commandName ?? 'command'}\``;
    const view = visible === undefined ? existing ? visibleComment(existing.body) : initial : visible;
    const body = commentBody(`${marker}\n${view.startsWith(marker) ? view.slice(marker.length).trimStart() : view}`, [...recordMarkers(existing?.body ?? ''), ...(record ? [encodeRecord(this.repo, number, record.key, record.value)] : [])]);
    if (existing?.body === body) return existing;
    const route = existing ? 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' : 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments';
    const args = existing ? { comment_id: existing.id, body } : { issue_number: number, body };
    const saved = await this.write(`managed-comment:${number}:${await sha256(marker)}:${await sha256(body)}`, route, args, async () => {
      const current = existing ? await this.read('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { comment_id: existing.id }) : (await this.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number }, undefined, true)).find(matches);
      if (current?.body === body) return current;
      if (current && (!existing || current.body !== expectedBody)) throw new Retryable('Piper comment changed during update');
      return undefined;
    });
    if (saved) await this.rememberComment(number, saved);
    return saved;
  }
  async ensureStatus(number: number) { return this.managedComment(number, STATUS_MARKER); }
  private async replyMarker(job = this.job) { return `<!-- piper:${await sha256('command:' + job)} -->`; }
  async replyFor(number: number, job: string, body: string, actor?: string) {
    const completed = actor ? undefined : await this.getRecord<{ actor?: string }>(number, 'command-done:' + job);
    const recipient = actor ?? completed?.actor;
    return this.managedComment(number, await this.replyMarker(job), typeof recipient === 'string' ? addressUser({ login: recipient, type: 'User' }, body) : body);
  }
  async reply(number: number, body: string, actor?: string) {
    this.commandResult = body;
    return this.managedComment(number, await this.replyMarker(), actor ? addressUser({ login: actor, type: 'User' }, body) : body);
  }
  async record<T>(number: number, key: string, value: T, result?: string, placement?: 'status'): Promise<T | null> {
    const marker = this.commandName && key.startsWith('command-done:') && placement !== 'status' ? await this.replyMarker() : STATUS_MARKER;
    const saved = await this.managedComment(number, marker, result, { key, value });
    return saved ? decodeRecords(saved, this.env.BOT_LOGIN, this.repo, number).find(r => r.key === key)?.value as T ?? value : null;
  }
  async comment(number: number, key: string, body: string) {
    const marker = `<!-- piper:${await sha256(key)} -->`;
    return this.write(`comment:${number}:${key}`, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number, body: `${body}\n\n${marker}` }, async () => {
      const comments = await this.list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: number }, undefined, true);
      return comments.find(x => x.user?.login === this.env.BOT_LOGIN && x.user?.type === 'Bot' && x.body?.includes(marker));
    });
  }
  async setLabels(number: number, labels: string[], key: string) {
    if (!labels.length) return;
    // Add only. Preserve human and other integrations' labels.
    return this.write(key, 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { issue_number: number, labels }, async () => {
      const existing = await this.list('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', { issue_number: number });
      return labels.every(x => existing.some(e => e.name === x)) ? existing : undefined;
    });
  }
  async content(path: string, ref: string) {
    try {
      const file = await this.read('GET /repos/{owner}/{repo}/contents/{path}', { path, ref });
      if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 65536) throw new Denied('Configuration is not a small regular file');
      return { text: new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))), sha: file.sha as string };
    } catch (e) { if (statusCode(e) === 404) return { text: '', sha: 'absent' }; throw e; }
  }
}
export function installationApi(env: Env, installationId: number): Requester {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY, installationId }, retry: { enabled: false }, throttle: { enabled: false } });
}
export function appApi(env: Env): Requester {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY }, retry: { enabled: false }, throttle: { enabled: false } });
}
export const stopped = (env: Env, repo: string) => env.EMERGENCY_STOP === 'true' || names(env.STOPPED_REPOSITORIES ?? '').includes(repo.toLowerCase());
