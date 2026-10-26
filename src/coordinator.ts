import { DurableObject } from 'cloudflare:workers';
import { allowed } from './config';
import { stopped } from './github';
import { JobScheduler, type JobResult } from './scheduler';
import { processJob } from './worker';
import { Retryable, type Env, type Job } from './types';

export function coordinatorKey(job: Job, repositoryOnly = false) {
  return job.repo.toLowerCase() + (repositoryOnly || !job.number ? ':repository' : ':issue:' + job.number);
}
export async function coordinate(env: Env, job: Job, repositoryOnly = false): Promise<JobResult> {
  if (
    !job ||
    typeof job.repo !== 'string' ||
    typeof job.id !== 'string' ||
    !['command', 'welcome', 'scan', 'release', 'reconcile', 'status', 'notice', 'labels', 'merge-poll'].includes(
      job.kind,
    ) ||
    !allowed(env, job.repo) ||
    !Number.isSafeInteger(job.installation) ||
    job.installation <= 0
  )
    return 'ack';
  if (!['scan', 'release'].includes(job.kind) && (!Number.isSafeInteger(job.number) || job.number! <= 0)) return 'ack';
  if (stopped(env, job.repo)) return 'retry';
  if (!env.COORDINATORS) throw new Retryable('Task coordinator binding is required');
  const stub = env.COORDINATORS.get(env.COORDINATORS.idFromName(coordinatorKey(job, repositoryOnly)));
  const response = await stub.fetch('https://coordinator.internal/jobs', {
    method: 'POST',
    body: JSON.stringify({ job, repositoryOnly }),
  });
  if (!response.ok) throw new Retryable('Task coordinator unavailable');
  const result = await response.json<{ result: JobResult }>();
  if (!['ack', 'retry'].includes(result.result)) throw new Retryable('Invalid coordinator response');
  return result.result;
}

export class TaskCoordinator extends DurableObject<Env> {
  private readonly jobs = new JobScheduler(
    (job, repositoryOnly) => this.execute(job, repositoryOnly),
    (previous, next) =>
      console.log(
        JSON.stringify({
          service: 'piper',
          event: 'jobs-coalesced',
          repo: next.repo,
          job: next.id,
          previous: previous.id,
        }),
      ),
  );
  protected async execute(job: Job, repositoryOnly: boolean): Promise<JobResult> {
    // Stack plans share receipts across PRs. Serialize every job that can update those receipts.
    // Always acquire the issue coordinator before the repository coordinator, never reverse.
    if (!repositoryOnly && ['command', 'reconcile', 'status', 'labels', 'notice', 'merge-poll'].includes(job.kind))
      return coordinate(this.env, job, true);
    return processJob(this.env, job);
  }
  async fetch(request: Request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/jobs')
      return new Response(null, { status: 404 });
    const { job, repositoryOnly } = await request.json<{ job: Job; repositoryOnly?: boolean }>();
    if (
      !job ||
      typeof job.repo !== 'string' ||
      typeof job.id !== 'string' ||
      typeof job.time !== 'string' ||
      (repositoryOnly !== undefined && typeof repositoryOnly !== 'boolean')
    )
      return new Response(null, { status: 400 });
    return Response.json({ result: await this.jobs.submit(job, repositoryOnly) });
  }
}

export async function consume(batch: MessageBatch<Job>, env: Env) {
  const groups = new Map<string, Message<Job>[]>();
  for (const message of batch.messages) {
    const key = typeof message.body?.repo === 'string' ? coordinatorKey(message.body) : crypto.randomUUID();
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  const pending = [...groups.values()];
  const handle = async (message: Message<Job>) => {
    try {
      if ((await coordinate(env, message.body)) === 'ack') {
        message.ack();
        return;
      }
    } catch {
      /* Preserve the original Queue message for retry. */
    }
    message.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.min(message.attempts, 6)) });
  };
  // Two groups per batch, two consumers: at most four independent resources.
  const run = async () => {
    for (let group = pending.shift(); group; group = pending.shift()) await Promise.all(group.map(handle));
  };
  await Promise.all([run(), run()]);
}
