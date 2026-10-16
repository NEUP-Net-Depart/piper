import { allowed, parseConfig } from './config';
import { commandResult, executeCommand, parseCommand } from './commands';
import { GitHub, appApi, installationApi, stopped, type Requester } from './github';
import { getPR, reconcilePR, refreshPR, welcome } from './pulls';
import { listReleases, prepareRelease, syncRelease } from './releases';
import { Denied, names, sha256, type Env, type Job, type PR } from './types';
import { addressUser } from './mentions';

export async function installationFor(env: Env, repo: string, api = appApi(env)): Promise<number> {
  if (!allowed(env,repo)) throw new Denied('Repository outside allowlist');
  const [owner,name] = repo.split('/');
  const response = await api.request('GET /repos/{owner}/{repo}/installation', { owner, repo: name, request: { timeout: 20000 } });
  if (!Number.isSafeInteger(response.data.id) || response.data.id <= 0) throw new Denied('Invalid installation ID');
  return response.data.id;
}
function affectedPR(pr: PR, job: Job, repo: string) {
  if (job.configChanged) return true;
  if (job.head && !job.baseChanged) return pr.head.sha === job.head;
  if (job.branch) {
    if (job.baseChanged && pr.base.ref === job.branch) return true;
    return pr.head.sha === job.head || pr.head.repo?.full_name.toLowerCase() === repo.toLowerCase() && pr.head.ref === job.branch;
  }
  return !job.head || pr.head.sha === job.head;
}
async function dispatch(gh: GitHub, job: Job) {
  const refresh = () => gh.env.TASKS.send({ id: job.id + ':status', repo: gh.repo, installation: job.installation, kind: 'status', number: job.number, time: new Date().toISOString() } satisfies Job);
  if (job.kind === 'command') {
    const current = await gh.read('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { comment_id: job.commentId });
    if (current.user?.type !== 'User' || current.user.login !== job.actor || await sha256(current.body) !== job.bodyHash || current.issue_url.toLowerCase() !== ('https://api.github.com/repos/' + gh.repo + '/issues/' + job.number).toLowerCase()) throw new Denied('命令评论身份、正文或归属已改变');
    gh.actor = current.user.login; gh.commandOrder = current.id;
    const completed = await gh.getRecord(job.number!, 'command-done:' + job.id);
    const command = parseCommand(current.body);
    if (!command) return;
    gh.commandName = command.name;
    const issue = await gh.read('GET /repos/{owner}/{repo}/issues/{issue_number}', { issue_number: job.number });
    if (!completed) {
      if (issue.pull_request) await gh.ensureStatus(job.number!);
      await executeCommand(gh, job.number!, current.user.login, command, !!issue.pull_request);
      await gh.record(job.number!, 'command-done:' + job.id, { commentId: current.id, bodyHash: job.bodyHash, actor: current.user.login }, addressUser(current.user, gh.commandResult ?? commandResult(command)));
    }
    // Enqueue after the receipt, including on retry after a lost Queue acknowledgement.
    if (!gh.dryRun && issue.pull_request && command.name !== 'help' && !(command.name === 'release' && command.args === 'status') && !(command.name === 'reviewers' && !command.args)) await refresh();
  } else if (job.kind === 'welcome') {
    const issue = await gh.read('GET /repos/{owner}/{repo}/issues/{issue_number}', { issue_number: job.number });
    if (!issue.pull_request) await welcome(gh, job.number!, issue.user, 'issue');
  } else if (['reconcile', 'status', 'labels', 'notice'].includes(job.kind)) {
    const more = job.kind === 'reconcile' ? await reconcilePR(gh, job.number!, true) : await refreshPR(gh, job.number!);
    if (more && !gh.dryRun) await refresh();
    if (gh.config!.release.enabled) {
      const pr = await getPR(gh, job.number!);
      if (pr.user.login === gh.env.BOT_LOGIN && pr.user.type === 'Bot' && pr.body?.startsWith('<!-- piper-release:v1:')) {
        await gh.env.TASKS.send({ id: job.id + ':release', repo: gh.repo, installation: job.installation, kind: 'release', time: job.time, syncOnly: true });
      }
    }
  } else if (job.kind === 'release') {
    if (!gh.config!.release.enabled) return;
    if (!job.syncOnly) await prepareRelease(gh,new Date(job.time));
    for (const release of await listReleases(gh)) if (!['published','cancelled'].includes(release.state)) await syncRelease(gh,release);
  } else if (job.kind === 'scan') {
    const open = await gh.list<PR>('GET /repos/{owner}/{repo}/pulls',{ state: 'open' });
    // Poll recent closed PRs as a fallback for a lost merged webhook (tags/welcome).
    const closed: PR[] = [];
    const cutoff = job.closedSince ? Date.parse(job.closedSince) : Date.parse(job.time) - 30 * 86400000;
    for (let page = 1; job.includeClosed && page <= 100; page++) {
      const batch = await gh.read<any[]>('GET /repos/{owner}/{repo}/pulls',{ state: 'closed', sort: 'updated', direction: 'desc', per_page: 100, page });
      closed.push(...batch.filter(p => Date.parse(p.updated_at) >= cutoff));
      if (batch.length < 100 || batch.some(p => Date.parse(p.updated_at) < cutoff)) break;
      if (page === 100) throw new Denied('Recent PR scan limit exceeded');
    }
    const affected = [...open, ...closed].filter(pr => affectedPR(pr, job, gh.repo));
    for (const pr of affected) await gh.env.TASKS.send({ id: job.id + ':pr:' + pr.number, repo: gh.repo, installation: job.installation, kind: 'reconcile', number: pr.number, time: job.time });
    const release = gh.config!.release;
    const deployment = (!job.workflow || job.workflow === release.deploymentWorkflow) && (!job.branch || job.branch === release.target);
    if (release.enabled && (!job.syncOnly || deployment)) await gh.env.TASKS.send({ id: job.id + ':release', repo: gh.repo, installation: job.installation, kind: 'release', time: job.time, syncOnly: job.syncOnly });
  }
}
export async function processJob(env: Env, job: Job, api?: Requester): Promise<'ack' | 'retry'> {
  let gh: GitHub | undefined;
  try {
    if (!allowed(env,job.repo) || !Number.isSafeInteger(job.installation) || job.installation <= 0) throw new Denied('Invalid repository or installation');
    if (stopped(env,job.repo)) return 'retry';
    gh = new GitHub(env,job.repo,job.id,api ?? installationApi(env,job.installation));
    gh.useReadCache();
    const repo = await gh.read('GET /repos/{owner}/{repo}');
    if (repo.full_name.toLowerCase() !== job.repo.toLowerCase()) throw new Denied('Repository identity changed');
    const file = await gh.content('.piper.yml',repo.default_branch);
    gh.config = parseConfig(env.ORG_DEFAULTS,file.text);
    if (!gh.config.enabled) { gh.audit('job','disabled'); return 'ack'; }
    if (job.checkName && !gh.config.merge.requiredChecks.includes(job.checkName) && !gh.config.release.requiredChecks.includes(job.checkName)) { gh.audit('job', 'irrelevant-check'); return 'ack'; }
    gh.audit('configuration','loaded',{ ref: repo.default_branch, sha: file.sha, defaultsHash: await sha256(env.ORG_DEFAULTS) });
    await dispatch(gh,job); gh.audit('job','completed', { requests: gh.requests }); return 'ack';
  } catch(e) {
    const denied = e instanceof Denied;
    const message = e instanceof Error ? e.message.slice(0,1000) : 'Unknown failure';
    gh?.audit('job',denied ? 'denied' : 'retry',{ message });
    if (denied && gh?.config?.enabled && job.kind === 'command' && gh.actor !== 'piper') {
      try { await gh.reply(job.number!, '请求未完成：' + message.replace(/@/g,'@\u200b') + '\n\n请按提示新建评论重试，或请仓库维护者协助。发送 `/help` 查看命令。', gh.actor); }
      catch { return 'retry'; }
    }
    return denied ? 'ack' : 'retry';
  }
}
export async function tick(env: Env, date: Date, api?: Requester) {
  if (env.EMERGENCY_STOP === 'true') return;
  const failures: unknown[] = [];
  for (const repo of names(env.ALLOWED_REPOSITORIES)) {
    if (!allowed(env,repo) || stopped(env,repo)) continue;
    try {
      const installation = await installationFor(env,repo,api);
      const full = date.getUTCHours() === 0 && date.getUTCMinutes() < 15;
      await env.TASKS.send({ id: 'cron:' + repo + ':' + Math.floor(date.getTime()/900000), repo, installation, kind: 'scan', time: date.toISOString(), includeClosed: true, ...(full ? {} : { closedSince: new Date(date.getTime() - 3600000).toISOString() }) });
    } catch(e) { failures.push(e); console.error(JSON.stringify({ service: 'piper', event: 'cron-repo-failed', repo })); }
  }
  if (failures.length) throw new Error('Some repositories could not be scanned; see cron-repo-failed logs');
}
