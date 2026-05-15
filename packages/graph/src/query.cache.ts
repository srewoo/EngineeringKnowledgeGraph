/**
 * Query cache — LRU cache for expensive graph queries.
 *
 * Caches deterministic query results with configurable TTL.
 * Invalidated when a new ingestion completes for a repo.
 */

import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

interface CacheEntry<T> {
  readonly data: T;
  readonly cachedAt: number;
  readonly ttlMs: number;
}

export class QueryCache {
  private readonly cache: Map<string, CacheEntry<unknown>>;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly logger: Logger;

  constructor(options?: { maxSize?: number; defaultTtlMs?: number }) {
    this.cache = new Map();
    this.maxSize = options?.maxSize ?? 500;
    this.defaultTtlMs = options?.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.logger = createLogger({ service: 'query-cache' });
  }

  /**
   * Get a cached value, or undefined if expired/missing.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const age = Date.now() - entry.cachedAt;
    if (age > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data as T;
  }

  /**
   * Store a value in the cache.
   */
  set<T>(key: string, data: T, ttlMs?: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
  }

  /**
   * Get or compute: returns cached value if available,
   * otherwise calls the factory function and caches the result.
   */
  async getOrCompute<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      this.logger.debug({ key }, 'Cache hit');
      return cached;
    }

    this.logger.debug({ key }, 'Cache miss — computing');
    const data = await factory();
    this.set(key, data, ttlMs);
    return data;
  }

  /**
   * Invalidate all entries for a specific repo (after ingestion).
   */
  invalidateByRepo(repoUrl: string): number {
    let deleted = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(repoUrl)) {
        this.cache.delete(key);
        deleted++;
      }
    }
    this.logger.info({ repoUrl, entriesInvalidated: deleted }, 'Cache invalidated for repo');
    return deleted;
  }

  /**
   * Clear entire cache.
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.info({ entriesCleared: size }, 'Cache cleared');
  }

  /**
   * Get cache stats.
   */
  stats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxSize };
  }

  /**
   * Build a cache key from a query name and parameters.
   */
  static key(queryName: string, params: Record<string, unknown>): string {
    return `${queryName}:${JSON.stringify(params)}`;
  }
}
