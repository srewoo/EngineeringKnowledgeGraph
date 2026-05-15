import { describe, it, expect, vi } from 'vitest';
import {
  SnapshotScheduler,
  cadenceMs,
  type SchedulerSnapshotRepo,
} from '../../src/snapshot.scheduler.js';
import type { RawCrossEdge, SnapshotService, SnapshotSource } from '../../src/snapshot.builder.js';

class StubSource implements SnapshotSource {
  async fetchServices(): Promise<readonly SnapshotService[]> {
    return [{ id: 'svc:a', name: 'a' }];
  }
  async fetchInterServiceEdges(): Promise<readonly RawCrossEdge[]> {
    return [];
  }
  async fetchNodeCounts(): Promise<Readonly<Record<string, number>>> {
    return { Service: 1 };
  }
}

class StubRepo implements SchedulerSnapshotRepo {
  saved: Array<{ label: string; payload: string; createdAt: string }> = [];
  private latestEntry: { label: string; createdAt: string } | undefined;

  setLatest(entry: { label: string; createdAt: string } | undefined) {
    this.latestEntry = entry;
  }

  save(label: string, payload: string) {
    const createdAt = new Date().toISOString();
    this.saved.push({ label, payload, createdAt });
    this.latestEntry = { label, createdAt };
    return { id: `id-${this.saved.length}`, createdAt };
  }

  latest() {
    return this.latestEntry;
  }
}

describe('SnapshotScheduler.runOnce', () => {
  it('saves a snapshot under an auto-YYYY-MM-DD label', async () => {
    const source = new StubSource();
    const repo = new StubRepo();
    const fixedNow = new Date('2026-05-15T12:00:00.000Z');
    const sched = new SnapshotScheduler({
      source, repo, cadence: 'monthly', now: () => fixedNow,
    });
    await sched.runOnce();
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0]?.label).toBe('auto-2026-05-15');
    const payload = JSON.parse(repo.saved[0]!.payload);
    expect(payload.version).toBe(1);
    expect(payload.summary.serviceCount).toBe(1);
  });
});

describe('SnapshotScheduler off-mode', () => {
  it('does not schedule or run when cadence=off', () => {
    const source = new StubSource();
    const repo = new StubRepo();
    const sched = new SnapshotScheduler({ source, repo, cadence: 'off' });
    sched.start();
    expect(sched.nextFireAt()).toBeNull();
    sched.stop();
  });
});

describe('SnapshotScheduler.stop', () => {
  it('cancels the next scheduled fire', async () => {
    vi.useFakeTimers();
    try {
      const source = new StubSource();
      const repo = new StubRepo();
      // Pretend an auto-snapshot just happened so catch-up doesn't fire.
      repo.setLatest({ label: 'auto-2026-05-15', createdAt: new Date().toISOString() });
      const sched = new SnapshotScheduler({ source, repo, cadence: 'daily' });
      sched.start();
      sched.stop();
      // Advance time past the cadence; runOnce must NOT have been invoked.
      vi.advanceTimersByTime(cadenceMs('daily') + 1000);
      // Allow microtasks
      await Promise.resolve();
      expect(repo.saved).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SnapshotScheduler catch-up', () => {
  it('runs immediately on start when no recent auto-snapshot exists', async () => {
    const source = new StubSource();
    const repo = new StubRepo();
    repo.setLatest(undefined);
    const sched = new SnapshotScheduler({ source, repo, cadence: 'monthly' });
    sched.start();
    // Allow the fire-and-forget runOnce promise to settle.
    await new Promise((r) => setImmediate(r));
    sched.stop();
    expect(repo.saved.length).toBeGreaterThanOrEqual(1);
  });

  it('skips catch-up when a fresh auto-snapshot exists', async () => {
    const source = new StubSource();
    const repo = new StubRepo();
    repo.setLatest({ label: 'auto-2026-05-15', createdAt: new Date().toISOString() });
    const sched = new SnapshotScheduler({ source, repo, cadence: 'monthly' });
    sched.start();
    await new Promise((r) => setImmediate(r));
    sched.stop();
    expect(repo.saved).toHaveLength(0);
  });
});
