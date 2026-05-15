/**
 * SnapshotScheduler — in-process cron-lite that periodically captures the
 * architecture graph into the SnapshotRepository.
 *
 * Implementation note: this uses a `setTimeout` chain rather than a real
 * cron daemon. A real cron would require a separate process; for a local-first
 * MCP server, in-process is the right trade-off (simple, no extra moving parts,
 * loses precision across restarts but recovers on `start()` via the catch-up
 * check). For multi-host deployments, swap this for a real scheduler.
 */

import { createLogger, type Logger } from '@ekg/shared';
import {
  buildSnapshot,
  snapshotByteSize,
  SNAPSHOT_WARN_BYTES,
  type SnapshotSource,
} from './snapshot.builder.js';

export type SnapshotCadence = 'daily' | 'weekly' | 'monthly' | 'off';

export const DEFAULT_CADENCE: SnapshotCadence = 'monthly';
export const SCHEDULER_LABEL_PREFIX = 'auto-';

export interface SchedulerSnapshotRepo {
  save(label: string, payload: string): { readonly id: string; readonly createdAt: string };
  latest(): { readonly label: string; readonly createdAt: string } | undefined;
}

export interface SchedulerDeps {
  readonly source: SnapshotSource;
  readonly repo: SchedulerSnapshotRepo;
  /** Override cadence; when omitted reads from `EKG_SNAPSHOT_SCHEDULE`. */
  readonly cadence?: SnapshotCadence;
  /** Override "now" for tests. */
  readonly now?: () => Date;
}

export class SnapshotScheduler {
  private readonly source: SnapshotSource;
  private readonly repo: SchedulerSnapshotRepo;
  private readonly cadence: SnapshotCadence;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: SchedulerDeps) {
    this.source = deps.source;
    this.repo = deps.repo;
    this.cadence = deps.cadence ?? readCadenceFromEnv();
    this.now = deps.now ?? (() => new Date());
    this.logger = createLogger({ service: 'snapshot-scheduler' });
  }

  start(): void {
    if (this.cadence === 'off') {
      this.logger.info('Scheduler disabled (EKG_SNAPSHOT_SCHEDULE=off)');
      return;
    }
    this.stopped = false;
    // Catch-up: if the latest auto-snapshot is older than one cadence window,
    // run once now. Manual snapshots don't count.
    if (this.shouldCatchUp()) {
      this.logger.info({ cadence: this.cadence }, 'No recent auto-snapshot — running catch-up');
      void this.runOnce().catch((err) => {
        this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'catch-up failed');
      });
    }
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Compute next-fire wallclock, exposed for status tooling. */
  nextFireAt(): Date | null {
    if (this.cadence === 'off') return null;
    return new Date(this.now().getTime() + cadenceMs(this.cadence));
  }

  async runOnce(): Promise<void> {
    const t0 = Date.now();
    const payload = await buildSnapshot(this.source);
    const bytes = snapshotByteSize(payload);
    if (bytes > SNAPSHOT_WARN_BYTES) {
      this.logger.warn({ bytes }, 'auto-snapshot exceeds 5MB warn threshold');
    }
    const isoDay = this.now().toISOString().slice(0, 10);
    const label = `${SCHEDULER_LABEL_PREFIX}${isoDay}`;
    this.repo.save(label, JSON.stringify(payload));
    this.logger.info({ label, ms: Date.now() - t0, bytes }, 'auto-snapshot saved');
  }

  private scheduleNext(): void {
    if (this.stopped || this.cadence === 'off') return;
    const totalMs = cadenceMs(this.cadence);
    this.armTimer(totalMs);
  }

  /**
   * Node's setTimeout caps at 2^31-1 ms (~24.8 days). For monthly cadence we
   * chain shorter timers; each wake either fires the snapshot or re-arms with
   * the remaining delay.
   */
  private armTimer(remainingMs: number): void {
    if (this.stopped) return;
    const cap = 2_147_483_000; // safely under 2^31-1
    const wait = Math.min(remainingMs, cap);
    this.timer = setTimeout(() => {
      const left = remainingMs - wait;
      if (left > 0) {
        this.armTimer(left);
        return;
      }
      void this.runOnce()
        .catch((err) => {
          this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'scheduled snapshot failed');
        })
        .finally(() => this.scheduleNext());
    }, wait);
    this.timer.unref?.();
  }

  private shouldCatchUp(): boolean {
    const latest = this.repo.latest();
    if (!latest) return true;
    if (!latest.label.startsWith(SCHEDULER_LABEL_PREFIX)) return true;
    const lastMs = Date.parse(latest.createdAt);
    if (!Number.isFinite(lastMs)) return true;
    const ageMs = this.now().getTime() - lastMs;
    return ageMs >= cadenceMs(this.cadence);
  }
}

export function readCadenceFromEnv(): SnapshotCadence {
  const raw = (process.env['EKG_SNAPSHOT_SCHEDULE'] ?? DEFAULT_CADENCE).toLowerCase().trim();
  if (raw === 'daily' || raw === 'weekly' || raw === 'monthly' || raw === 'off') return raw;
  return DEFAULT_CADENCE;
}

export function cadenceMs(c: SnapshotCadence): number {
  const day = 24 * 60 * 60 * 1000;
  switch (c) {
    case 'daily': return day;
    case 'weekly': return 7 * day;
    case 'monthly': return 30 * day;
    case 'off': return Number.POSITIVE_INFINITY;
  }
}
