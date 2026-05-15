/**
 * Unit tests for the per-repo retry helper inside BulkIngestionService.
 *
 * We don't reach for a full ingestion stack — instead we drive the public
 * runWriteWithRetry path by injecting a fake IngestionService whose
 * ingestFromClone() yields a configurable sequence of outcomes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulkIngestionService } from '../../src/bulk.ingestion.js';
import { computeBackoffMs } from '../../src/bulk.retry.js';
import type { IngestionService, CloneOnlyResult } from '../../src/ingestion.service.js';
import { SqliteRepository } from '@ekg/storage';

// We never persist for these tests — but BulkIngestionService needs a real
// SqliteRepository instance because it instantiates DlqRepository on the
// underlying connection.
function makeDeps(): { svc: BulkIngestionService; calls: { count: number }; sqlite: SqliteRepository } {
  const sqlite = new SqliteRepository(':memory:');
  const calls = { count: 0 };
  // The fake — overridden per-test below.
  const fakeIngest = {
    ingestFromClone: vi.fn(async () => ({ status: 'COMPLETED', nodesCreated: 1, edgesCreated: 1 })),
  } as unknown as IngestionService;
  const svc = new BulkIngestionService(fakeIngest, sqlite, 60_000, {
    maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0,
  });
  return { svc, calls, sqlite };
}

describe('computeBackoffMs', () => {
  it('produces 1s/4s/16s with base=1000 factor=4 and zero jitter', () => {
    const cfg = { maxAttempts: 3, baseDelayMs: 1_000, backoffFactor: 4, jitter: 0 };
    expect(computeBackoffMs(cfg, 1)).toBe(1_000);
    expect(computeBackoffMs(cfg, 2)).toBe(4_000);
    expect(computeBackoffMs(cfg, 3)).toBe(16_000);
  });

  it('applies bounded ±jitter', () => {
    const cfg = { maxAttempts: 3, baseDelayMs: 1_000, backoffFactor: 2, jitter: 0.2 };
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(cfg, 2);
      expect(ms).toBeGreaterThanOrEqual(1_600);
      expect(ms).toBeLessThanOrEqual(2_400);
    }
  });
});

describe('BulkIngestionService.runWriteWithRetry (via private invocation)', () => {
  // Access the private method via cast — we want to test the retry logic
  // without bringing up the full producer-consumer pipeline.
  type WriteResult =
    | { succeeded: true; nodes: number; edges: number; attempts: number }
    | { succeeded: false; error: string; category: string; attempts: number };

  type Internal = {
    runWriteWithRetry(
      bulkJobId: string,
      repo: { fullPath: string; httpUrl: string },
      cloned: CloneOnlyResult,
      retry: { maxAttempts: number; baseDelayMs: number; backoffFactor: number; jitter: number },
      label: () => string,
    ): Promise<WriteResult>;
  };

  let sqlite: SqliteRepository;
  beforeEach(() => {
    if (sqlite) sqlite.close();
  });

  function buildSvc(seq: Array<{ throw?: Error; status?: 'COMPLETED' | 'FAILED'; error?: string }>): BulkIngestionService {
    sqlite = new SqliteRepository(':memory:');
    let i = 0;
    const fake = {
      ingestFromClone: vi.fn(async () => {
        const step = seq[i++];
        if (!step) throw new Error('No more scripted steps');
        if (step.throw) throw step.throw;
        return { status: step.status ?? 'COMPLETED', nodesCreated: 0, edgesCreated: 0, error: step.error };
      }),
    } as unknown as IngestionService;
    return new BulkIngestionService(fake, sqlite, 60_000, {
      maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0,
    });
  }

  const repo = { fullPath: 'group/proj', httpUrl: 'https://git/x.git' };
  const cloned = {} as CloneOnlyResult;

  it('returns success on first attempt without sleeping', async () => {
    const svc = buildSvc([{ status: 'COMPLETED' }]);
    const result = await (svc as unknown as Internal).runWriteWithRetry(
      'b1', repo, cloned,
      { maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0 },
      () => '1/1',
    );
    expect(result.succeeded).toBe(true);
    if (result.succeeded) expect(result.attempts).toBe(1);
  });

  it('retries on retryable categories then succeeds', async () => {
    const svc = buildSvc([
      { throw: new Error("ForsetiClient[tx=1] can't acquire ExclusiveLock{owner=Service}") },
      { throw: new Error('Ingest timed out after 600000ms') },
      { status: 'COMPLETED' },
    ]);
    const result = await (svc as unknown as Internal).runWriteWithRetry(
      'b1', repo, cloned,
      { maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0 },
      () => '1/1',
    );
    expect(result.succeeded).toBe(true);
    if (result.succeeded) expect(result.attempts).toBe(3);
  });

  it('does NOT retry terminal categories (PARSE_FAILED)', async () => {
    const svc = buildSvc([
      { throw: new Error('SyntaxError: Unexpected token in foo.ts') },
      // Should never be reached.
      { status: 'COMPLETED' },
    ]);
    const result = await (svc as unknown as Internal).runWriteWithRetry(
      'b1', repo, cloned,
      { maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0 },
      () => '1/1',
    );
    expect(result.succeeded).toBe(false);
    if (!result.succeeded) {
      expect(result.category).toBe('PARSE_FAILED');
      expect(result.attempts).toBe(1);
    }
  });

  it('exhausts attempts then surfaces the last error + category', async () => {
    const svc = buildSvc([
      { throw: new Error('Ingest timed out after 600000ms') },
      { throw: new Error('Ingest timed out after 600000ms') },
      { throw: new Error('Ingest timed out after 600000ms') },
    ]);
    const result = await (svc as unknown as Internal).runWriteWithRetry(
      'b1', repo, cloned,
      { maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0 },
      () => '1/1',
    );
    expect(result.succeeded).toBe(false);
    if (!result.succeeded) {
      expect(result.category).toBe('TIMEOUT');
      expect(result.attempts).toBe(3);
    }
  });

  it('treats an IngestionJob with status FAILED + retryable error as retryable', async () => {
    const svc = buildSvc([
      { status: 'FAILED', error: "ForsetiClient[tx=2] can't acquire ExclusiveLock" },
      { status: 'COMPLETED' },
    ]);
    const result = await (svc as unknown as Internal).runWriteWithRetry(
      'b1', repo, cloned,
      { maxAttempts: 3, baseDelayMs: 1, backoffFactor: 2, jitter: 0 },
      () => '1/1',
    );
    expect(result.succeeded).toBe(true);
    if (result.succeeded) expect(result.attempts).toBe(2);
  });
});
