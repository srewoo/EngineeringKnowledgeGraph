import { describe, it, expect } from 'vitest';
import { createLogger } from '@ekg/shared';
import { IngestQueue, type IngestJobRequest } from '../../src/queue.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('IngestQueue concurrency', () => {
  it('drops a duplicate enqueue for an already-running repo', async () => {
    const gate = deferred<void>();
    const seen: string[] = [];
    const queue = new IngestQueue({
      maxConcurrent: 5,
      runner: async (r: IngestJobRequest) => {
        seen.push(r.repoUrl);
        await gate.promise;
      },
      logger: createLogger({ service: 'test' }),
    });
    const a1 = queue.enqueue({ repoUrl: 'a', branch: 'main', commitSha: 's1' });
    const a2 = queue.enqueue({ repoUrl: 'a', branch: 'main', commitSha: 's2' });
    expect(a1.accepted).toBe(true);
    expect(a2.accepted).toBe(false);
    expect(a2.reason).toBe('duplicate-repo');
    gate.resolve();
    await queue.drain();
    expect(seen).toEqual(['a']);
  });

  it('respects maxConcurrent and queues FIFO', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const start: string[] = [];
    const queue = new IngestQueue({
      maxConcurrent: 2,
      runner: async (r: IngestJobRequest) => {
        start.push(r.repoUrl);
        const g = deferred<void>();
        gates.push(g);
        await g.promise;
      },
      logger: createLogger({ service: 'test' }),
    });

    queue.enqueue({ repoUrl: 'a', branch: 'main', commitSha: 's' });
    queue.enqueue({ repoUrl: 'b', branch: 'main', commitSha: 's' });
    queue.enqueue({ repoUrl: 'c', branch: 'main', commitSha: 's' });
    queue.enqueue({ repoUrl: 'd', branch: 'main', commitSha: 's' });

    // let the runners actually start
    await new Promise((r) => setImmediate(r));
    expect(start).toEqual(['a', 'b']);
    expect(queue.inFlight()).toBe(2);
    expect(queue.depth()).toBe(2);

    // release first slot — c should start, d still queued
    gates[0]?.resolve();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(start).toEqual(['a', 'b', 'c']);

    // drain the rest
    gates[1]?.resolve();
    await new Promise((r) => setImmediate(r));
    gates[2]?.resolve();
    await new Promise((r) => setImmediate(r));
    gates[3]?.resolve();
    await queue.drain();

    expect(start).toEqual(['a', 'b', 'c', 'd']);
  });
});
