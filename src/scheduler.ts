import type { Job } from './types';

export type JobResult = 'ack' | 'retry';
interface PendingJob {
  job: Job;
  repositoryOnly: boolean;
  resolve: ((result: JobResult) => void)[];
  start: () => void;
}
const views = new Set<Job['kind']>(['reconcile', 'status', 'labels', 'notice']);
function group(job: Job) {
  if (views.has(job.kind)) return 'pr';
  if (job.kind === 'scan') return 'scan';
  if (job.releaseRunId) return undefined;
  if (job.kind === 'release') return job.syncOnly ? 'release-sync' : 'release:' + job.time.slice(0, 10);
  return undefined;
}
function merge(previous: Job, next: Job): Job {
  return {
    ...next,
    kind: views.has(next.kind)
      ? previous.kind === 'reconcile' || next.kind === 'reconcile'
        ? 'reconcile'
        : 'status'
      : next.kind,
    time: Date.parse(previous.time) > Date.parse(next.time) ? previous.time : next.time,
    checkName: previous.checkName === next.checkName ? next.checkName : undefined,
    head: previous.head === next.head ? next.head : undefined,
    branch: previous.branch === next.branch ? next.branch : undefined,
    workflow: previous.workflow === next.workflow ? next.workflow : undefined,
    baseChanged: previous.baseChanged || next.baseChanged,
    configChanged: previous.configChanged || next.configChanged,
    stackChanged: previous.stackChanged || next.stackChanged,
    includeClosed: previous.includeClosed || next.includeClosed,
    closedSince:
      previous.closedSince && next.closedSince ? [previous.closedSince, next.closedSince].sort()[0] : undefined,
    syncOnly: previous.syncOnly === true && next.syncOnly === true,
  };
}

// Queue messages remain unacknowledged until the shared computation finishes.
// Losing this transient scheduler only causes Queue redelivery, never loss of intent.
export class JobScheduler {
  private running = false;
  private readonly pending: PendingJob[] = [];
  constructor(
    private readonly run: (job: Job, repositoryOnly: boolean) => Promise<JobResult>,
    private readonly coalesced?: (previous: Job, next: Job) => void,
  ) {}
  submit(job: Job, repositoryOnly = false): Promise<JobResult> {
    return new Promise((resolve) => {
      const last = this.pending.at(-1),
        key = group(job);
      if (
        last &&
        key &&
        group(last.job) === key &&
        last.repositoryOnly === repositoryOnly &&
        last.job.installation === job.installation &&
        last.job.repo.toLowerCase() === job.repo.toLowerCase() &&
        last.job.number === job.number &&
        last.resolve.length < 128
      ) {
        this.coalesced?.(last.job, job);
        last.job = merge(last.job, job);
        last.resolve.push(resolve);
      } else {
        if (this.pending.length >= 64) {
          resolve('retry');
          return;
        }
        let start!: () => void;
        const ready = new Promise<void>((resolve) => {
          start = resolve;
        });
        const item = { job, repositoryOnly, resolve: [resolve], start };
        this.pending.push(item);
        // Create this continuation in the submitting request's context. A single
        // drain loop would charge all queued jobs to the first invocation.
        void this.execute(item, ready);
      }
      if (!this.running) {
        this.running = true;
        void Promise.resolve().then(() => this.advance());
      }
    });
  }
  private advance() {
    const item = this.pending.shift();
    if (!item) {
      this.running = false;
      return;
    }
    item.start();
  }
  private async execute(item: PendingJob, ready: Promise<void>) {
    await ready;
    let result: JobResult;
    try {
      result = await this.run(item.job, item.repositoryOnly);
    } catch {
      result = 'retry';
    }
    for (const resolve of item.resolve) resolve(result);
    this.advance();
  }
}
