/**
 * Dead-letter-queue repository for permanently-failed bulk-ingest repos.
 *
 * After all retry attempts are exhausted, BulkIngestionService writes the
 * failure here so an operator can: (a) see which repos failed and why
 * grouped by category, (b) resolve them after a fix, (c) re-enqueue them
 * via the retry_dlq MCP tool.
 *
 * The row id is `sha256(bulkJobId + repoUrl)` so re-failure within the same
 * bulk job upserts in place (attempts counter increments).
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ERROR_CATEGORIES } from '@ekg/shared';
import type { ErrorCategory } from '@ekg/shared';

export interface DlqRow {
  readonly id: string;
  readonly bulkJobId: string;
  readonly repoUrl: string;
  readonly repoName: string;
  readonly errorCategory: ErrorCategory;
  readonly errorMessage: string;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly resolvedAt?: string;
}

export interface DlqUpsert {
  readonly bulkJobId: string;
  readonly repoUrl: string;
  readonly repoName: string;
  readonly errorCategory: ErrorCategory;
  readonly errorMessage: string;
  readonly attempts: number;
}

function dlqId(bulkJobId: string, repoUrl: string): string {
  return createHash('sha256').update(`${bulkJobId}::${repoUrl}`).digest('hex');
}

export class DlqRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Idempotent upsert. On conflict, bumps attempts and updates last_failed_at +
   * latest error fields; preserves first_failed_at and resolved_at.
   */
  upsert(row: DlqUpsert): void {
    const id = dlqId(row.bulkJobId, row.repoUrl);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO dead_letter_repos
        (id, bulk_job_id, repo_url, repo_name, error_category, error_message,
         attempts, first_failed_at, last_failed_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (id) DO UPDATE SET
        error_category = excluded.error_category,
        error_message = excluded.error_message,
        attempts = excluded.attempts,
        last_failed_at = excluded.last_failed_at,
        resolved_at = NULL
    `).run(
      id, row.bulkJobId, row.repoUrl, row.repoName,
      row.errorCategory, row.errorMessage,
      row.attempts, now, now,
    );
  }

  listUnresolved(bulkJobId?: string): DlqRow[] {
    const rows = bulkJobId
      ? this.db.prepare(
          'SELECT * FROM dead_letter_repos WHERE resolved_at IS NULL AND bulk_job_id = ? ORDER BY last_failed_at DESC',
        ).all(bulkJobId) as Record<string, unknown>[]
      : this.db.prepare(
          'SELECT * FROM dead_letter_repos WHERE resolved_at IS NULL ORDER BY last_failed_at DESC',
        ).all() as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  listByCategory(category: ErrorCategory, bulkJobId?: string): DlqRow[] {
    const rows = bulkJobId
      ? this.db.prepare(
          'SELECT * FROM dead_letter_repos WHERE resolved_at IS NULL AND bulk_job_id = ? AND error_category = ? ORDER BY last_failed_at DESC',
        ).all(bulkJobId, category) as Record<string, unknown>[]
      : this.db.prepare(
          'SELECT * FROM dead_letter_repos WHERE resolved_at IS NULL AND error_category = ? ORDER BY last_failed_at DESC',
        ).all(category) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  markResolved(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE dead_letter_repos SET resolved_at = ? WHERE id = ?',
    ).run(now, id);
  }

  countByCategory(bulkJobId?: string): Record<ErrorCategory, number> {
    const counts: Record<ErrorCategory, number> = Object.fromEntries(
      ERROR_CATEGORIES.map((c) => [c, 0]),
    ) as Record<ErrorCategory, number>;

    const rows = bulkJobId
      ? this.db.prepare(
          'SELECT error_category, COUNT(*) AS n FROM dead_letter_repos WHERE resolved_at IS NULL AND bulk_job_id = ? GROUP BY error_category',
        ).all(bulkJobId) as { error_category: string; n: number }[]
      : this.db.prepare(
          'SELECT error_category, COUNT(*) AS n FROM dead_letter_repos WHERE resolved_at IS NULL GROUP BY error_category',
        ).all() as { error_category: string; n: number }[];

    for (const row of rows) {
      const cat = row.error_category as ErrorCategory;
      if (cat in counts) counts[cat] = row.n;
    }
    return counts;
  }

  /** Helper for the retry_dlq tool — resolves all rows matching a bulkJobId/category. */
  idForRepo(bulkJobId: string, repoUrl: string): string {
    return dlqId(bulkJobId, repoUrl);
  }
}

function mapRow(row: Record<string, unknown>): DlqRow {
  return {
    id: row['id'] as string,
    bulkJobId: row['bulk_job_id'] as string,
    repoUrl: row['repo_url'] as string,
    repoName: row['repo_name'] as string,
    errorCategory: row['error_category'] as ErrorCategory,
    errorMessage: row['error_message'] as string,
    attempts: row['attempts'] as number,
    firstFailedAt: row['first_failed_at'] as string,
    lastFailedAt: row['last_failed_at'] as string,
    resolvedAt: (row['resolved_at'] as string) ?? undefined,
  };
}
