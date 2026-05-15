/**
 * RepoStateRepository — tracks per-repo freshness/drift state.
 *
 * Distinct from `ingestion_jobs` (job history). This is the *current* state
 * of a repo: last successful SHA, when we last ingested it, last failure.
 *
 * Used by data_freshness MCP tool and by IngestionService on success/failure.
 */

import Database from 'better-sqlite3';

export interface RepoState {
  readonly repoUrl: string;
  readonly lastSha?: string;
  readonly lastIngestedAt: string;
  readonly lastFailedAt?: string;
  readonly lastError?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class RepoStateRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_state (
        repo_url TEXT PRIMARY KEY,
        last_sha TEXT,
        last_ingested_at TEXT NOT NULL,
        last_failed_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_repo_state_last_ingested
        ON repo_state(last_ingested_at);
    `);
  }

  upsertOnSuccess(repoUrl: string, sha: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO repo_state (repo_url, last_sha, last_ingested_at, last_failed_at, last_error)
      VALUES (?, ?, ?, NULL, NULL)
      ON CONFLICT (repo_url) DO UPDATE SET
        last_sha = excluded.last_sha,
        last_ingested_at = excluded.last_ingested_at,
        last_failed_at = NULL,
        last_error = NULL
    `).run(repoUrl, sha, now);
  }

  upsertOnFailure(repoUrl: string, errorMessage: string): void {
    const now = new Date().toISOString();
    // Preserve last_ingested_at on failure (and last_sha) — only mark the failure.
    const existing = this.findByUrl(repoUrl);
    this.db.prepare(`
      INSERT INTO repo_state (repo_url, last_sha, last_ingested_at, last_failed_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (repo_url) DO UPDATE SET
        last_failed_at = excluded.last_failed_at,
        last_error = excluded.last_error
    `).run(
      repoUrl,
      existing?.lastSha ?? null,
      existing?.lastIngestedAt ?? now,
      now,
      truncate(errorMessage, 1000),
    );
  }

  findByUrl(repoUrl: string): RepoState | undefined {
    const row = this.db.prepare(
      'SELECT * FROM repo_state WHERE repo_url = ?',
    ).get(repoUrl) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getAll(): readonly RepoState[] {
    const rows = this.db.prepare(
      'SELECT * FROM repo_state ORDER BY last_ingested_at DESC',
    ).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  findStale(maxAgeDays: number): readonly RepoState[] {
    const cutoff = new Date(Date.now() - maxAgeDays * DAY_MS).toISOString();
    const rows = this.db.prepare(
      'SELECT * FROM repo_state WHERE last_ingested_at < ? ORDER BY last_ingested_at ASC',
    ).all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): RepoState {
    const lastSha = row['last_sha'] as string | null;
    const lastFailedAt = row['last_failed_at'] as string | null;
    const lastError = row['last_error'] as string | null;
    return {
      repoUrl: row['repo_url'] as string,
      ...(lastSha ? { lastSha } : {}),
      lastIngestedAt: row['last_ingested_at'] as string,
      ...(lastFailedAt ? { lastFailedAt } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}...`;
}
