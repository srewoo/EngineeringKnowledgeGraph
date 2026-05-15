/**
 * Helpers for BulkIngestionService retry policy. Kept in a separate file so
 * `bulk.ingestion.ts` doesn't balloon further.
 *
 * Backoff is exponential with ±jitter — driven by `BulkRetryConfig` so the
 * caller can override per-environment via env vars without touching code.
 */

export interface BulkRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly backoffFactor: number;
  /** Fractional jitter, e.g. 0.2 = ±20% of computed delay. */
  readonly jitter: number;
}

export const DEFAULT_BULK_RETRY: BulkRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  backoffFactor: 4,
  jitter: 0.2,
};

/**
 * Backoff for the failed try at index `attempt` (1-indexed).
 * With base=1000ms, factor=4: attempt 1 → 1s, 2 → 4s, 3 → 16s.
 */
export function computeBackoffMs(retry: BulkRetryConfig, attempt: number): number {
  if (attempt < 1) return 0;
  const base = retry.baseDelayMs * Math.pow(retry.backoffFactor, attempt - 1);
  const jitterFactor = 1 + (Math.random() * 2 - 1) * retry.jitter;
  return Math.max(0, Math.floor(base * jitterFactor));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
