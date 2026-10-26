import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { JobScheduler } from '../src/scheduler';
import { consume, coordinate, coordinatorKey } from '../src/coordinator';
import { app } from '../src/index';
import type { Env, Job } from '../src/types';
import { repo, testEnv } from './fixtures';

const job = (id: string, kind: Job['kind'] = 'reconcile', rest: Partial<Job> = {}): Job => ({
  id,
  repo,
  installation: 1,
  number: 1,
  kind,
  time: '2026-10-17T08:00:00Z',
  ...rest,
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('resource task coordination', () => {
  it('serializes across external awaits and coalesces pending checks without crossing command barriers', async () => {
    const started = deferred(),
      release = deferred();
    const seen: Job[] = [];
    let active = 0,
      maximum = 0;
    const scheduler = new JobScheduler(async (task) => {
      maximum = Math.max(maximum, ++active);
      seen.push(task);
      if (seen.length === 1) {
        started.resolve();
        await release.promise;
      }
      active--;
      return 'ack';
    });
    const first = scheduler.submit(job('active'));
    await started.promise;
    const pending = [
      scheduler.submit(job('status', 'status')),
      scheduler.submit(job('latest')),
      scheduler.submit(job('command-1', 'command')),
      scheduler.submit(job('labels', 'labels')),
      scheduler.submit(job('notice', 'notice')),
      scheduler.submit(job('command-2', 'command')),
    ];
    const acknowledged = vi.fn();
    void pending[0]!.then(acknowledged);
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    release.resolve();
    expect(await Promise.all([first, ...pending])).toEqual(Array(7).fill('ack'));
    expect(maximum).toBe(1);
    expect(seen.map((x) => [x.id, x.kind])).toEqual([
      ['active', 'reconcile'],
      ['latest', 'reconcile'],
      ['command-1', 'command'],
      ['notice', 'status'],
      ['command-2', 'command'],
    ]);
  });

  it('shares a failed computation with all covered messages and keeps later commands runnable', async () => {
    const run = vi.fn(async (task: Job) => {
      if (task.kind !== 'command') throw new Error('GitHub offline');
      return 'ack' as const;
    });
    const scheduler = new JobScheduler(run);
    const result = await Promise.all([
      scheduler.submit(job('old')),
      scheduler.submit(job('new')),
      scheduler.submit(job('command', 'command')),
    ]);
    expect(result).toEqual(['retry', 'retry', 'ack']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await scheduler.submit(job('redelivery'))).toBe('retry');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('keeps broad recovery scans and relevant checks when event hints differ', async () => {
    const seen: Job[] = [];
    const scheduler = new JobScheduler(async (task) => {
      seen.push(task);
      return 'ack';
    });
    await Promise.all([
      scheduler.submit(job('required', 'reconcile', { checkName: 'verify' })),
      scheduler.submit(job('optional', 'status', { checkName: 'optional' })),
    ]);
    expect(seen[0]).toMatchObject({ kind: 'reconcile', checkName: undefined });
    seen.length = 0;
    await Promise.all([
      scheduler.submit(job('full', 'scan', { number: undefined, includeClosed: true })),
      scheduler.submit(job('narrow', 'scan', { number: undefined, head: 'new', closedSince: '2026-10-17T07:00:00Z' })),
    ]);
    expect(seen[0]).toMatchObject({ includeClosed: true, head: undefined, closedSince: undefined });
  });

  it('does not collapse commands, installations or distinct scheduled release days', async () => {
    const run = vi.fn(async () => 'ack' as const),
      scheduler = new JobScheduler(run);
    await Promise.all([
      scheduler.submit(job('command', 'command')),
      scheduler.submit(job('command', 'command')),
      scheduler.submit(job('old-installation')),
      scheduler.submit(job('new-installation', 'reconcile', { installation: 2 })),
      scheduler.submit(job('thursday', 'release', { time: '2026-10-22T10:00:00Z' })),
      scheduler.submit(job('friday', 'release', { time: '2026-10-23T10:00:00Z' })),
    ]);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it('uses a real Durable Object to serialize overlapping requests without blocking another PR', async () => {
    const namespace = (env as unknown as Env).COORDINATORS!;
    const one = namespace.get(namespace.idFromName('test:' + crypto.randomUUID()));
    const two = namespace.get(namespace.idFromName('test:' + crypto.randomUUID()));
    const seen: string[] = [];
    await runInDurableObject(one, (instance) => {
      vi.spyOn(instance as unknown as { execute: (job: Job) => Promise<string> }, 'execute').mockImplementation(
        async (task) => {
          seen.push(task.id);
          if (task.id === 'one') await new Promise((resolve) => setTimeout(resolve, 100));
          return 'ack';
        },
      );
    });
    await runInDurableObject(two, (instance) => {
      vi.spyOn(instance as unknown as { execute: (job: Job) => Promise<string> }, 'execute').mockImplementation(
        async (task) => {
          seen.push(task.id);
          return 'ack';
        },
      );
    });
    const send = (stub: DurableObjectStub, task: Job) =>
      stub.fetch('https://coordinator.internal/jobs', { method: 'POST', body: JSON.stringify({ job: task }) });
    const responses = await Promise.all([send(one, job('one')), send(one, job('two')), send(two, job('independent'))]);
    expect(responses.every((r) => r.ok)).toBe(true);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual(Array(3).fill({ result: 'ack' }));
    expect(seen.indexOf('one')).toBeLessThan(seen.indexOf('two'));
    expect(seen.indexOf('independent')).toBeLessThan(seen.indexOf('two'));
  });

  it('fails closed without a coordinator binding and preserves retry delays', async () => {
    const environment = testEnv();
    expect((await app.request('/health', {}, environment)).status).toBe(503);
    await expect(coordinate(environment, job('missing'))).rejects.toThrow('binding');
    const message = { body: job('missing'), attempts: 3, ack: vi.fn(), retry: vi.fn() };
    await consume({ messages: [message] } as unknown as MessageBatch<Job>, environment);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(coordinatorKey(job('pr'))).not.toBe(coordinatorKey(job('pr'), true));
    expect(coordinatorKey(job('other', 'status', { number: 2 }))).not.toBe(coordinatorKey(job('pr')));
  });

  it('serializes repository commands, Stack reconciliation and automatic merges from different PRs', async () => {
    const namespace = (env as unknown as Env).COORDINATORS!;
    const repository = namespace.get(namespace.idFromName(coordinatorKey(job('release'), true)));
    let active = 0,
      maximum = 0;
    const seen: { id: string; repositoryOnly: boolean }[] = [];
    await runInDurableObject(repository, (instance) => {
      vi.spyOn(
        instance as unknown as { execute: (task: Job, repositoryOnly: boolean) => Promise<string> },
        'execute',
      ).mockImplementation(async (task, repositoryOnly) => {
        maximum = Math.max(maximum, ++active);
        seen.push({ id: task.id, repositoryOnly });
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return 'ack';
      });
    });
    const environment = testEnv({ COORDINATORS: namespace });
    expect(
      await Promise.all([
        coordinate(environment, job('release', 'command', { number: 1001, repository: true })),
        coordinate(environment, job('legacy', 'command', { number: 1002 })),
        coordinate(environment, job('stack-bottom', 'reconcile', { number: 1003 })),
        coordinate(environment, job('stack-top', 'reconcile', { number: 1004 })),
        coordinate(environment, job('legacy-integrate', 'command', { number: 1005, repository: false })),
        coordinate(environment, job('receipt-refresh', 'status', { number: 1006 })),
        coordinate(environment, job('metadata', 'command', { number: 1007, repository: false })),
      ]),
    ).toEqual(Array(7).fill('ack'));
    expect(maximum).toBe(1);
    expect(seen).toHaveLength(7);
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: 'release', repositoryOnly: true },
        { id: 'legacy', repositoryOnly: true },
        { id: 'stack-bottom', repositoryOnly: true },
        { id: 'stack-top', repositoryOnly: true },
        { id: 'legacy-integrate', repositoryOnly: true },
        { id: 'receipt-refresh', repositoryOnly: true },
        { id: 'metadata', repositoryOnly: true },
      ]),
    );
  });
});
