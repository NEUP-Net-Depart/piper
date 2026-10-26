import { Hono } from 'hono';
import { allowed } from './config';
import { Denied, sha256, names, type Env, type Job } from './types';
import { installationFor, tick } from './worker';
import { parseCommand } from './commands';
import { GitHub, installationApi } from './github';
import { consume } from './coordinator';
export { TaskCoordinator } from './coordinator';

export const app = new Hono<{ Bindings: Env }>();
const events = new Set([
  'ping',
  'pull_request',
  'pull_request_review',
  'issue_comment',
  'issues',
  'check_run',
  'check_suite',
  'status',
  'push',
  'workflow_run',
]);
export async function verifySignature(secret: string, body: ArrayBuffer, signature: string): Promise<boolean> {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(signature.slice(7).match(/.{2}/g)!, (x) => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, bytes, body);
}
async function limitedBody(req: Request, max: number) {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}
app.get('/health', (c) =>
  c.json(
    { service: 'piper', environment: c.env.ENVIRONMENT, status: c.env.COORDINATORS ? 'ok' : 'misconfigured' },
    c.env.COORDINATORS ? 200 : 503,
  ),
);
app.post('/webhooks/github', async (c) => {
  const body = await limitedBody(c.req.raw, 2 * 1024 * 1024);
  if (!body) return c.json({ error: 'payload too large' }, 413);
  if (!(await verifySignature(c.env.WEBHOOK_SECRET, body, c.req.header('x-hub-signature-256') ?? '')))
    return c.json({ error: 'invalid signature' }, 401);
  const event = c.req.header('x-github-event') ?? '';
  const delivery = c.req.header('x-github-delivery') ?? '';
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(delivery)) return c.json({ error: 'invalid delivery ID' }, 400);
  if (!events.has(event)) return c.json({ ignored: true }, 202);
  let data: any;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (event === 'ping') return c.json({ pong: true });
  const repo = data.repository?.full_name;
  const installation = data.installation?.id;
  if (typeof repo !== 'string' || !allowed(c.env, repo)) return c.json({ ignored: true }, 202);
  if (!Number.isSafeInteger(installation) || installation <= 0) return c.json({ error: 'installation required' }, 400);
  const time = new Date().toISOString();
  if (
    event === 'pull_request' &&
    data.sender?.login === c.env.BOT_LOGIN &&
    data.sender?.type === 'Bot' &&
    ['edited', 'labeled', 'unlabeled', 'review_requested', 'review_request_removed'].includes(data.action)
  )
    return c.json({ ignored: true }, 202);
  if (event === 'workflow_run' && data.action !== 'completed') return c.json({ ignored: true }, 202);
  if (event === 'check_suite' && data.action !== 'completed') return c.json({ ignored: true }, 202);
  if (event === 'check_run' && data.action === 'requested_action') return c.json({ ignored: true }, 202);
  if (event === 'push' && (data.deleted || (typeof data.ref === 'string' && !data.ref.startsWith('refs/heads/'))))
    return c.json({ ignored: true }, 202);
  let job: Job = {
    id: `webhook:${await sha256(event + ':' + new TextDecoder().decode(body))}`,
    repo,
    installation,
    kind: 'scan',
    time,
  };
  if (event === 'check_run' && typeof data.check_run?.name === 'string') job.checkName = data.check_run.name;
  if (event === 'status' && typeof data.context === 'string') job.checkName = data.context;
  if (['check_run', 'check_suite', 'workflow_run', 'status', 'push'].includes(event)) {
    const head =
      data.check_run?.head_sha ?? data.check_suite?.head_sha ?? data.workflow_run?.head_sha ?? data.sha ?? data.after;
    if (typeof head === 'string' && /^[0-9a-f]{40,64}$/i.test(head)) job.head = head;
    const branch =
      event === 'push'
        ? data.ref?.slice('refs/heads/'.length)
        : (data.workflow_run?.head_branch ?? data.check_suite?.head_branch);
    if (typeof branch === 'string' && branch.length > 0 && branch.length <= 255) job.branch = branch;
    if (typeof data.workflow_run?.path === 'string')
      job.workflow = data.workflow_run.path.split('@')[0]!.split('/').at(-1);
    if (event === 'push') {
      job.baseChanged = true;
      job.configChanged =
        branch === data.repository.default_branch &&
        (data.forced === true ||
          !Array.isArray(data.commits) ||
          data.commits.some((commit: any) =>
            ['added', 'modified', 'removed'].some((kind) => commit[kind]?.includes('.piper.yml')),
          ));
    }
    job.syncOnly = true;
  }
  if (event === 'issue_comment') {
    if (
      data.action !== 'created' ||
      data.comment?.user?.type !== 'User' ||
      data.comment.user.login !== data.sender?.login
    )
      return c.json({ ignored: true }, 202);
    if (typeof data.comment.body !== 'string') return c.json({ error: 'invalid comment body' }, 400);
    let command;
    try {
      command = parseCommand(data.comment.body);
      if (!command) return c.json({ ignored: true }, 202);
    } catch (e) {
      if (e instanceof Denied) return c.json({ error: e.message }, 400);
      throw e;
    }
    job = {
      ...job,
      id: `command:${repo.toLowerCase()}:${data.comment.id}`,
      kind: 'command',
      number: data.issue?.number,
      commentId: data.comment.id,
      bodyHash: await sha256(data.comment.body),
      actor: data.sender.login,
      repository: ['release', 'backport', 'tag'].includes(command.name),
    };
  } else if (event === 'issues') {
    if (data.action !== 'opened') return c.json({ ignored: true }, 202);
    job = { ...job, kind: 'welcome', number: data.issue?.number };
  } else if (event === 'pull_request' || event === 'pull_request_review')
    job = { ...job, kind: 'reconcile', number: data.pull_request?.number };
  if (['command', 'welcome', 'reconcile'].includes(job.kind) && (!Number.isSafeInteger(job.number) || job.number! <= 0))
    return c.json({ error: 'invalid issue number' }, 400);
  if (job.kind === 'command' && (!Number.isSafeInteger(job.commentId) || job.commentId! <= 0))
    return c.json({ error: 'invalid comment ID' }, 400);
  const related =
    event === 'check_run'
      ? data.check_run?.pull_requests
      : event === 'check_suite'
        ? data.check_suite?.pull_requests
        : event === 'workflow_run'
          ? data.workflow_run?.pull_requests
          : undefined;
  let jobs = [job];
  if (Array.isArray(related) && related.length) {
    const numbers = [...new Set(related.map((p: any) => p.number))];
    if (numbers.length > 100 || numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))
      return c.json({ error: 'invalid related PRs' }, 400);
    jobs = numbers.map((number) => ({ ...job, id: job.id + ':pr:' + number, kind: 'reconcile', number }));
  }
  // Compact message is the only durable receipt. Never acknowledge before send succeeds.
  try {
    for (const item of jobs) await c.env.TASKS.send(item);
  } catch (e) {
    console.error(JSON.stringify({ service: 'piper', event: 'enqueue-unconfirmed', delivery, job: job.id, repo }));
    throw e;
  }
  console.log(JSON.stringify({ service: 'piper', event: 'enqueued', delivery, job: job.id, repo }));
  return c.json({ accepted: true, id: delivery }, 202);
});
app.use('/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const actual = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!expected || expected.length < 32 || actual.length !== expected.length)
    return c.json({ error: 'unauthorized' }, 401);
  // Constant-time comparison through HMAC verification, without retaining raw token hashes.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(expected),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('piper-admin'));
  const candidate = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(actual),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  if (!(await crypto.subtle.verify('HMAC', candidate, sig, new TextEncoder().encode('piper-admin'))))
    return c.json({ error: 'unauthorized' }, 401);
  await next();
});
app.get('/admin/status', (c) =>
  c.json({
    service: 'piper',
    environment: c.env.ENVIRONMENT,
    database: false,
    coordination: c.env.COORDINATORS ? 'durable-objects' : 'unconfigured',
    emergencyStop: c.env.EMERGENCY_STOP === 'true',
    stoppedRepositories: names(c.env.STOPPED_REPOSITORIES ?? ''),
    allowedRepositories: names(c.env.ALLOWED_REPOSITORIES),
    dryRun: c.env.DRY_RUN !== 'false',
    recovery: 'GitHub webhook redelivery or Queue DLQ replay; admin/reconcile requests a fresh scan',
    audit: 'GitHub Bot receipts and Workers structured logs',
  }),
);
app.post('/admin/reconcile', async (c) => {
  const repo = c.req.query('repo') ?? '';
  if (!allowed(c.env, repo)) return c.json({ error: 'repository outside allowlist' }, 400);
  const installation = await installationFor(c.env, repo),
    time = new Date().toISOString();
  await c.env.TASKS.send({
    id: 'operator:' + crypto.randomUUID(),
    repo,
    installation,
    kind: 'scan',
    time,
    includeClosed: true,
  });
  console.log(JSON.stringify({ service: 'piper', action: 'operator-reconcile', repo, time }));
  return c.json({ accepted: true }, 202);
});
app.get('/admin/audit', async (c) => {
  const repo = c.req.query('repo') ?? '',
    number = Number(c.req.query('number'));
  if (!allowed(c.env, repo) || !Number.isSafeInteger(number) || number <= 0)
    return c.json({ error: 'allowed repo and positive issue number required' }, 400);
  const installation = await installationFor(c.env, repo);
  const gh = new GitHub(c.env, repo, 'audit-read', installationApi(c.env, installation));
  return c.json({ source: 'GitHub Bot receipts', records: await gh.records(number) });
});
app.onError((e, c) => {
  console.error(JSON.stringify({ event: 'request-failed', type: e.name }));
  return c.json({ error: 'request failed; retry delivery if queue acknowledgement was not received' }, 500);
});
export default {
  fetch: app.fetch,
  queue: consume,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env, Job>;
