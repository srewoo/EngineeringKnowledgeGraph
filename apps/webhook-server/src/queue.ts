/**
 * IngestQueue — bounded FIFO with per-repo locks and a global concurrency cap.
 *
 * - Per-repo lock: a second push for an already-running repo is dropped (logged).
 * - Global cap: when at `maxConcurrent`, new accepted jobs queue up FIFO.
 * - In-process only — no external broker. Restart-safe via the underlying
 *   ingestion job table (ingestion is idempotent).
 */

import { createLogger, type Logger } from '@ekg/shared';

export interface IngestJobRequest {
  readonly repoUrl: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly token?: string;
}

export type IngestRunner = (req: IngestJobRequest) => Promise<void>;

export interface QueueOptions {
  readonly maxConcurrent: number;
  readonly runner: IngestRunner;
  readonly logger?: Logger;
}

export interface EnqueueResult {
  readonly accepted: boolean;
  readonly reason?: 'duplicate-repo';
  readonly queueDepth: number;
  readonly inFlight: number;
}

interface PendingJob {
  readonly req: IngestJobRequest;
}

export class IngestQueue {
  private readonly maxConcurrent: number;
  private readonly runner: IngestRunner;
  private readonly logger: Logger;
  private readonly pending: PendingJob[] = [];
  /** Repo URLs currently running OR queued — the per-repo lock set. */
  private readonly active: Set<string> = new Set();
  private inFlightCount = 0;
  private drainResolvers: Array<() => void> = [];

  constructor(opts: QueueOptions) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.runner = opts.runner;
    this.logger = opts.logger ?? createLogger({ service: 'ekg-webhook-queue' });
  }

  enqueue(req: IngestJobRequest): EnqueueResult {
    if (this.active.has(req.repoUrl)) {
      this.logger.info(
        { repoUrl: req.repoUrl },
        'webhook duplicate; ignoring (per-repo lock)',
      );
      return {
        accepted: false,
        reason: 'duplicate-repo',
        queueDepth: this.pending.length,
        inFlight: this.inFlightCount,
      };
    }
    this.active.add(req.repoUrl);
    this.pending.push({ req });
    this.logger.info(
      {
        repoUrl: req.repoUrl,
        sha: req.commitSha,
        branch: req.branch,
        queueDepth: this.pending.length,
        inFlight: this.inFlightCount,
      },
      'webhook job enqueued',
    );
    this.pump();
    return {
      accepted: true,
      queueDepth: this.pending.length,
      inFlight: this.inFlightCount,
    };
  }

  private pump(): void {
    while (this.inFlightCount < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) break;
      this.inFlightCount += 1;
      void this.runOne(next.req);
    }
  }

  private async runOne(req: IngestJobRequest): Promise<void> {
    const t0 = Date.now();
    try {
      await this.runner(req);
      this.logger.info(
        { repoUrl: req.repoUrl, durationMs: Date.now() - t0 },
        'webhook job completed',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { repoUrl: req.repoUrl, err: msg, durationMs: Date.now() - t0 },
        'webhook job failed',
      );
    } finally {
      this.inFlightCount -= 1;
      this.active.delete(req.repoUrl);
      this.pump();
      if (this.inFlightCount === 0 && this.pending.length === 0) {
        const resolvers = this.drainResolvers.splice(0);
        for (const r of resolvers) r();
      }
    }
  }

  inFlight(): number {
    return this.inFlightCount;
  }

  depth(): number {
    return this.pending.length;
  }

  /** Resolves once all in-flight + queued jobs have settled. */
  drain(): Promise<void> {
    if (this.inFlightCount === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}
