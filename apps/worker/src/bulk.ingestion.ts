/**
 * Bulk ingestion service — ingests multiple repos with concurrency control.
 *
 * Runs in the background (non-blocking) so MCP tool calls don't timeout.
 * Progress is persisted to SQLite (bulk_jobs) so it survives MCP restarts
 * and is visible across multiple clients.
 */

import { createLogger, classifyError, isRetryableErrorCategory } from '@ekg/shared';
import type { Logger, ErrorCategory } from '@ekg/shared';
import { IngestionService } from './ingestion.service.js';
import type { CloneOnlyResult } from './ingestion.service.js';
import { GitLabClient } from '@ekg/parser';
import type { GitLabRepo } from '@ekg/parser';
import { SqliteRepository, DlqRepository } from '@ekg/storage';
import { computeBackoffMs, sleep, DEFAULT_BULK_RETRY } from './bulk.retry.js';
import type { BulkRetryConfig } from './bulk.retry.js';
export type { BulkRetryConfig } from './bulk.retry.js';

export interface BulkIngestionProgress {
  readonly bulkJobId: string;
  readonly status: 'DISCOVERING' | 'INGESTING' | 'COMPLETED' | 'FAILED';
  readonly totalDiscovered: number;
  readonly totalIngested: number;
  readonly totalFailed: number;
  readonly totalSkipped: number;
  readonly currentRepo: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly skippedRepos: readonly { name: string; reason: string }[];
  readonly failedRepos: readonly { name: string; error: string; errorCategory?: ErrorCategory; attempts?: number }[];
  readonly successRepos: readonly { name: string; nodes: number; edges: number }[];
  /** Repos discovered but not yet processed — used to resume after restart. */
  readonly pendingRepos: readonly GitLabRepo[];
  /** Concurrency the job was started with — needed to resume with same parallelism. */
  readonly concurrency: number;
}

export class BulkIngestionService {
  private readonly ingestionService: IngestionService;
  private readonly gitlabClient: GitLabClient;
  private readonly sqliteRepo: SqliteRepository;
  private readonly dlqRepo: DlqRepository;
  private readonly retryConfig: BulkRetryConfig;
  private readonly logger: Logger;
  private readonly ingestTimeoutMs: number;

  /** In-memory cache of active bulk jobs — mirrors SQLite for fast polling. */
  private readonly jobs = new Map<string, BulkIngestionProgress>();

  /** Promises for currently-running bulk loops — awaited on shutdown(). */
  private readonly inflight = new Set<Promise<void>>();

  /** Set when shutdown is requested; new repos in the queue are skipped. */
  private aborted = false;

  constructor(
    ingestionService: IngestionService,
    sqliteRepo: SqliteRepository,
    ingestTimeoutMs = 600_000,
    retryConfig: BulkRetryConfig = DEFAULT_BULK_RETRY,
  ) {
    this.ingestionService = ingestionService;
    this.gitlabClient = new GitLabClient();
    this.sqliteRepo = sqliteRepo;
    this.dlqRepo = new DlqRepository(sqliteRepo.getConnection());
    this.ingestTimeoutMs = ingestTimeoutMs;
    this.retryConfig = retryConfig;
    this.logger = createLogger({ service: 'bulk-ingestion' });
  }

  /** Exposed for the retry_dlq MCP tool. */
  getDlqRepository(): DlqRepository {
    return this.dlqRepo;
  }

  /**
   * Re-enqueue a list of repos by URL. Used by the retry_dlq tool.
   * Discovery is skipped — caller has already chosen the repos.
   */
  startBulkIngestForList(
    repoUrls: readonly string[],
    token: string,
    concurrency: number,
    branch = 'main',
  ): string {
    const bulkJobId = `bulk-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const repos: GitLabRepo[] = repoUrls.map((url) => ({
      id: 0,
      name: url.split('/').pop()?.replace(/\.git$/, '') ?? url,
      fullPath: url,
      httpUrl: url,
      sshUrl: url,
      defaultBranch: branch,
      repoSizeMb: 0,
      lastActivity: new Date().toISOString(),
      archived: false,
    }));

    const progress: BulkIngestionProgress = {
      bulkJobId,
      status: 'INGESTING',
      totalDiscovered: repos.length,
      totalIngested: 0,
      totalFailed: 0,
      totalSkipped: 0,
      currentRepo: '',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skippedRepos: [],
      failedRepos: [],
      successRepos: [],
      pendingRepos: [...repos],
      concurrency,
    };
    this.persist(progress);
    this.logger.info({ bulkJobId, count: repos.length }, 'Bulk re-ingest from list started');

    const promise = this.processQueue(bulkJobId, [...repos], repos.length, token, concurrency)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ bulkJobId, error: message }, 'Bulk re-ingest from list crashed');
        this.updateProgress(bulkJobId, { status: 'FAILED' });
      })
      .finally(() => { this.inflight.delete(promise); });
    this.inflight.add(promise);
    return bulkJobId;
  }

  /**
   * Drain in-flight bulk jobs gracefully.
   *
   * Sets the abort flag so the queue stops dispatching new repos, then waits
   * for the currently-running batch (already-started ingestions) to complete
   * — this prevents partial graph writes when SIGTERM arrives mid-merge.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.aborted = true;
    if (this.inflight.size === 0) return;
    this.logger.info({ inflight: this.inflight.size }, 'Draining in-flight bulk jobs');
    const drainAll = Promise.allSettled([...this.inflight]);
    const timeout = new Promise<void>((res) => setTimeout(res, timeoutMs));
    await Promise.race([drainAll, timeout]);
    this.logger.info('Bulk ingestion drained');
  }

  getProgress(bulkJobId: string): BulkIngestionProgress | undefined {
    const cached = this.jobs.get(bulkJobId);
    if (cached) return cached;

    const row = this.sqliteRepo.getBulkJob(bulkJobId);
    if (!row) return undefined;
    return this.rowToProgress(row);
  }

  listJobs(): { id: string; status: string; progress: string }[] {
    const rows = this.sqliteRepo.listBulkJobs();
    return rows.map((row) => ({
      id: row['id'] as string,
      status: row['status'] as string,
      progress: `${(row['total_ingested'] as number) + (row['total_failed'] as number)}/${row['total_discovered'] as number}`,
    }));
  }

  startBulkIngest(
    gitlabUrl: string,
    token: string,
    groupIds: readonly number[],
    maxRepoSizeMb: number,
    concurrency: number,
  ): string {
    const bulkJobId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const progress: BulkIngestionProgress = {
      bulkJobId,
      status: 'DISCOVERING',
      totalDiscovered: 0,
      totalIngested: 0,
      totalFailed: 0,
      totalSkipped: 0,
      currentRepo: '',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skippedRepos: [],
      failedRepos: [],
      successRepos: [],
      pendingRepos: [],
      concurrency,
    };

    this.persist(progress);
    this.logger.info({ bulkJobId, gitlabUrl, groupIds, maxRepoSizeMb, concurrency }, 'Bulk ingestion started');

    const promise = this.runBulkIngest(bulkJobId, gitlabUrl, token, groupIds, maxRepoSizeMb, concurrency)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ bulkJobId, error: message }, 'Bulk ingestion crashed');
        this.updateProgress(bulkJobId, { status: 'FAILED' });
      })
      .finally(() => { this.inflight.delete(promise); });
    this.inflight.add(promise);

    return bulkJobId;
  }

  private async runBulkIngest(
    bulkJobId: string,
    gitlabUrl: string,
    token: string,
    groupIds: readonly number[],
    maxRepoSizeMb: number,
    concurrency: number,
  ): Promise<void> {
    const repos = await this.gitlabClient.discoverRepos({
      gitlabUrl, token, groupIds, maxRepoSizeMb,
    });

    this.logger.info({ bulkJobId, repoCount: repos.length }, 'Repos discovered');
    this.updateProgress(bulkJobId, {
      status: 'INGESTING',
      totalDiscovered: repos.length,
      pendingRepos: [...repos],
    });

    await this.processQueue(bulkJobId, [...repos], repos.length, token, concurrency);
  }

  /**
   * Resume any DISCOVERING/INGESTING bulk jobs left over from a previous run.
   * Called once on startup. DISCOVERING jobs are marked FAILED (we can't
   * trust a partial discovery list); INGESTING jobs continue from
   * pendingRepos so already-ingested work is not redone.
   */
  resumeInterrupted(token: string): void {
    const rows = this.sqliteRepo.listBulkJobs();
    for (const row of rows) {
      const status = row['status'] as string;
      if (status !== 'DISCOVERING' && status !== 'INGESTING') continue;

      const progress = this.rowToProgress(row);
      if (status === 'DISCOVERING' || progress.pendingRepos.length === 0) {
        this.logger.warn({ bulkJobId: progress.bulkJobId, status }, 'Marking interrupted bulk job FAILED — nothing to resume');
        this.jobs.set(progress.bulkJobId, progress);
        this.updateProgress(progress.bulkJobId, { status: 'FAILED' });
        continue;
      }

      this.logger.info({
        bulkJobId: progress.bulkJobId,
        pending: progress.pendingRepos.length,
        ingested: progress.totalIngested,
        failed: progress.totalFailed,
      }, 'Resuming interrupted bulk job');

      this.jobs.set(progress.bulkJobId, progress);
      const total = progress.totalDiscovered;
      const concurrency = progress.concurrency || 5;
      const promise = this.processQueue(
        progress.bulkJobId,
        [...progress.pendingRepos],
        total,
        token,
        concurrency,
        {
          success: [...progress.successRepos],
          failed: [...progress.failedRepos],
          skipped: [...progress.skippedRepos],
        },
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ bulkJobId: progress.bulkJobId, error: message }, 'Resumed bulk job crashed');
        this.updateProgress(progress.bulkJobId, { status: 'FAILED' });
      }).finally(() => { this.inflight.delete(promise); });
      this.inflight.add(promise);
    }
  }

  /**
   * Continuous producer-consumer pipeline:
   *   - N clone workers pull from the input queue and push completed clones into a bounded buffer
   *   - M write workers pull from the buffer and run extract+graph-write
   *
   * Clone concurrency (network-bound) and write concurrency (Neo4j write-lock bound)
   * scale independently. Workers run continuously — no batch boundaries that idle
   * the network during writes or vice versa.
   *
   * `concurrency` controls write concurrency. Clone concurrency = 2× write, capped at 10.
   * Clone buffer is bounded at 2× clone concurrency to apply backpressure when writes lag.
   */
  private async processQueue(
    bulkJobId: string,
    queue: GitLabRepo[],
    totalCount: number,
    token: string,
    concurrency: number,
    seed?: {
      success: { name: string; nodes: number; edges: number }[];
      failed: { name: string; error: string; errorCategory?: ErrorCategory; attempts?: number }[];
      skipped: { name: string; reason: string }[];
    },
  ): Promise<void> {
    const skipped = seed?.skipped ?? [];
    const failed = seed?.failed ?? [];
    const success = seed?.success ?? [];

    const writeConcurrency = Math.min(Math.max(concurrency, 1), 32);
    const cloneConcurrency = Math.min(writeConcurrency * 2, 10);
    const bufferLimit = cloneConcurrency * 2;
    const retry = this.retryConfig;

    type Cloned = { repo: GitLabRepo; cloned: CloneOnlyResult };
    const buffer: Cloned[] = [];
    let cloneDone = false;
    const waiters: Array<() => void> = [];

    const notify = (): void => {
      while (waiters.length > 0) waiters.shift()!();
    };
    const waitForBufferSpace = async (): Promise<void> => {
      while (buffer.length >= bufferLimit && !this.aborted) {
        await new Promise<void>((res) => waiters.push(res));
      }
    };
    const waitForWork = async (): Promise<void> => {
      while (buffer.length === 0 && !cloneDone && !this.aborted) {
        await new Promise<void>((res) => waiters.push(res));
      }
    };

    const persistProgress = (): void => {
      this.updateProgress(bulkJobId, {
        totalIngested: success.length,
        totalFailed: failed.length,
        totalSkipped: skipped.length,
        skippedRepos: skipped,
        failedRepos: failed,
        successRepos: success,
        pendingRepos: [...queue],
      });
    };

    // Clone workers: pull repos off the queue, clone, push into buffer
    const cloneWorker = async (): Promise<void> => {
      while (!this.aborted) {
        const repo = queue.shift();
        if (!repo) return;

        await waitForBufferSpace();
        if (this.aborted) {
          skipped.push({ name: repo.fullPath, reason: 'shutdown' });
          continue;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.ingestTimeoutMs);
        try {
          this.updateProgress(bulkJobId, { currentRepo: repo.fullPath });
          const cloned = await this.ingestionService.cloneOnly({
            repoUrl: repo.httpUrl,
            branch: repo.defaultBranch,
            token,
            signal: controller.signal,
          });
          if (cloned.skipped) {
            success.push({ name: repo.fullPath, nodes: 0, edges: 0 });
          } else {
            buffer.push({ repo, cloned });
          }
          notify();
        } catch (error) {
          const lastError = error instanceof Error ? error.message : String(error);
          // Clone-stage failures default to CLONE_FAILED unless the classifier
          // sees a more specific signature (e.g. ETIMEDOUT on the abort path).
          const detected = classifyError(error);
          const errorCategory: ErrorCategory = detected === 'UNKNOWN' ? 'CLONE_FAILED' : detected;
          this.logger.warn({ bulkJobId, repo: repo.fullPath, error: lastError, errorCategory }, 'Clone failed');
          failed.push({ name: repo.fullPath, error: lastError, errorCategory, attempts: 1 });
          this.dlqRepo.upsert({
            bulkJobId,
            repoUrl: repo.httpUrl,
            repoName: repo.fullPath,
            errorCategory,
            errorMessage: lastError,
            attempts: 1,
          });
        } finally {
          clearTimeout(timer);
        }
      }
    };

    // Write workers: pull cloned repos from buffer, extract+write graph
    const writeWorker = async (): Promise<void> => {
      while (!this.aborted) {
        if (buffer.length === 0) {
          if (cloneDone) return;
          await waitForWork();
          continue;
        }
        const item = buffer.shift();
        if (!item) continue;
        notify(); // free up buffer space for clone workers

        const { repo, cloned } = item;
        const result = await this.runWriteWithRetry(bulkJobId, repo, cloned, retry, () =>
          `${success.length + failed.length + 1}/${totalCount}`,
        );
        if (result.succeeded) {
          success.push({ name: repo.fullPath, nodes: result.nodes, edges: result.edges });
        } else {
          failed.push({
            name: repo.fullPath,
            error: result.error,
            errorCategory: result.category,
            attempts: result.attempts,
          });
          this.dlqRepo.upsert({
            bulkJobId,
            repoUrl: repo.httpUrl,
            repoName: repo.fullPath,
            errorCategory: result.category,
            errorMessage: result.error,
            attempts: result.attempts,
          });
          this.logger.error({
            bulkJobId, repo: repo.fullPath,
            errorCategory: result.category, attempts: result.attempts, error: result.error,
          }, 'Repo ingestion failed — written to DLQ');
        }
        persistProgress();
      }
    };

    const cloners = Array.from({ length: cloneConcurrency }, () => cloneWorker());
    const writers = Array.from({ length: writeConcurrency }, () => writeWorker());

    await Promise.allSettled(cloners);
    cloneDone = true;
    notify();
    await Promise.allSettled(writers);

    if (this.aborted) {
      for (const repo of queue) skipped.push({ name: repo.fullPath, reason: 'shutdown' });
    }

    const finalStatus: BulkIngestionProgress['status'] = this.aborted ? 'INGESTING' : 'COMPLETED';
    this.updateProgress(bulkJobId, {
      status: finalStatus,
      totalIngested: success.length,
      totalFailed: failed.length,
      totalSkipped: skipped.length,
      currentRepo: '',
      completedAt: finalStatus === 'COMPLETED' ? new Date().toISOString() : undefined,
      skippedRepos: skipped,
      failedRepos: failed,
      successRepos: success,
      pendingRepos: [...queue],
    });

    this.logger.info({
      bulkJobId,
      totalDiscovered: totalCount,
      totalIngested: success.length,
      totalFailed: failed.length,
      pending: queue.length,
      status: finalStatus,
    }, 'Bulk ingestion run finished');
  }

  /**
   * Per-repo retry with exponential backoff + ±jitter.
   *
   * Retries only categories the classifier flags as transient (TIMEOUT, NEO4J_LOCK).
   * Terminal categories (PARSE_FAILED, OOM, CLONE_FAILED, UNKNOWN) bail on first failure
   * — retrying them is just wasted Neo4j load.
   */
  private async runWriteWithRetry(
    bulkJobId: string,
    repo: GitLabRepo,
    cloned: CloneOnlyResult,
    retry: BulkRetryConfig,
    progressLabel: () => string,
  ): Promise<
    | { succeeded: true; nodes: number; edges: number; attempts: number }
    | { succeeded: false; error: string; category: ErrorCategory; attempts: number }
  > {
    let lastError = 'Unknown error';
    let lastCategory: ErrorCategory = 'UNKNOWN';
    let attempt = 0;
    for (attempt = 1; attempt <= retry.maxAttempts && !this.aborted; attempt++) {
      try {
        this.logger.info({
          bulkJobId, repo: repo.fullPath, attempt,
          progress: progressLabel(),
        }, 'Writing graph');
        const job = await this.ingestionService.ingestFromClone(cloned, { repoUrl: repo.httpUrl });
        if (job.status === 'COMPLETED') {
          return { succeeded: true, nodes: job.nodesCreated, edges: job.edgesCreated, attempts: attempt };
        }
        lastError = job.error ?? 'Unknown error';
        lastCategory = classifyError(lastError);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        lastCategory = classifyError(error);
        this.logger.warn({
          bulkJobId, repo: repo.fullPath, attempt,
          errorCategory: lastCategory, error: lastError,
        }, 'Write attempt failed');
      }

      const isLast = attempt >= retry.maxAttempts;
      const retryable = isRetryableErrorCategory(lastCategory);
      if (isLast || !retryable) {
        if (!retryable) {
          this.logger.warn({
            bulkJobId, repo: repo.fullPath, attempt,
            errorCategory: lastCategory,
          }, 'Terminal error category — not retrying');
        }
        break;
      }

      const sleepMs = computeBackoffMs(retry, attempt);
      this.logger.warn({
        bulkJobId, repo: repo.fullPath, attempt,
        prevError: lastError, errorCategory: lastCategory, sleepMs,
      }, 'Retrying after backoff');
      await sleep(sleepMs);
    }
    // `attempt` holds the index of the last try we executed (loop exits via
    // `break` so the for-loop's post-increment didn't run).
    const lastAttemptCount = Math.max(1, Math.min(attempt, retry.maxAttempts));
    return { succeeded: false, error: lastError, category: lastCategory, attempts: lastAttemptCount };
  }

  private updateProgress(bulkJobId: string, update: Partial<BulkIngestionProgress>): void {
    const current = this.jobs.get(bulkJobId);
    if (!current) return;
    const next: BulkIngestionProgress = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.persist(next);
  }

  private persist(progress: BulkIngestionProgress): void {
    this.jobs.set(progress.bulkJobId, progress);
    try {
      this.sqliteRepo.upsertBulkJob({
        id: progress.bulkJobId,
        status: progress.status,
        totalDiscovered: progress.totalDiscovered,
        totalIngested: progress.totalIngested,
        totalFailed: progress.totalFailed,
        totalSkipped: progress.totalSkipped,
        currentRepo: progress.currentRepo,
        startedAt: progress.startedAt,
        updatedAt: progress.updatedAt,
        completedAt: progress.completedAt,
        payload: JSON.stringify({
          skippedRepos: progress.skippedRepos,
          failedRepos: progress.failedRepos,
          successRepos: progress.successRepos,
          pendingRepos: progress.pendingRepos,
          concurrency: progress.concurrency,
        }),
      });
    } catch (error) {
      this.logger.warn({ error }, 'Failed to persist bulk job — keeping in memory only');
    }
  }

  private rowToProgress(row: Record<string, unknown>): BulkIngestionProgress {
    let payload: {
      skippedRepos?: unknown;
      failedRepos?: unknown;
      successRepos?: unknown;
      pendingRepos?: unknown;
      concurrency?: unknown;
    } = {};
    try {
      payload = JSON.parse((row['payload'] as string) ?? '{}');
    } catch { /* ignore */ }

    return {
      bulkJobId: row['id'] as string,
      status: row['status'] as BulkIngestionProgress['status'],
      totalDiscovered: row['total_discovered'] as number,
      totalIngested: row['total_ingested'] as number,
      totalFailed: row['total_failed'] as number,
      totalSkipped: row['total_skipped'] as number,
      currentRepo: (row['current_repo'] as string) ?? '',
      startedAt: row['started_at'] as string,
      updatedAt: row['updated_at'] as string,
      completedAt: (row['completed_at'] as string) ?? undefined,
      skippedRepos: (payload.skippedRepos as { name: string; reason: string }[]) ?? [],
      failedRepos: (payload.failedRepos as { name: string; error: string; errorCategory?: ErrorCategory; attempts?: number }[]) ?? [],
      successRepos: (payload.successRepos as { name: string; nodes: number; edges: number }[]) ?? [],
      pendingRepos: (payload.pendingRepos as GitLabRepo[]) ?? [],
      concurrency: typeof payload.concurrency === 'number' ? payload.concurrency : 5,
    };
  }
}
