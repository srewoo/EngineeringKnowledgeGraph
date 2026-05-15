/**
 * UnresolvedHttpRepository — SQLite store for HTTP call sites that the
 * URL→API resolver could not link to a known API node (Phase 1.5).
 *
 * Surfaced via the `list_unresolved_http_calls` MCP tool so engineers can
 * read, fix the host hint config, and re-ingest. Per-row identity is
 * `(repoUrl, filePath, line, urlTemplate)` so re-ingesting upserts in place.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface UnresolvedHttpRow {
  readonly id: string;
  readonly repoUrl: string;
  readonly filePath: string;
  readonly line: number;
  readonly method: string;
  readonly urlTemplate: string;
  readonly clientLibrary: string;
  readonly reason: string;
  readonly lastSeen: string;
}

export interface UnresolvedHttpUpsert {
  readonly repoUrl: string;
  readonly filePath: string;
  readonly line: number;
  readonly method: string;
  readonly urlTemplate: string;
  readonly clientLibrary: string;
  readonly reason: string;
}

function rowId(u: UnresolvedHttpUpsert): string {
  const key = `${u.repoUrl}::${u.filePath}::${u.line}::${u.method}::${u.urlTemplate}`;
  return createHash('sha256').update(key).digest('hex');
}

export class UnresolvedHttpRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unresolved_http_calls (
        id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        method TEXT NOT NULL,
        url_template TEXT NOT NULL,
        client_library TEXT NOT NULL,
        reason TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_unresolved_http_repo
        ON unresolved_http_calls(repo_url);
    `);
  }

  upsertMany(rows: readonly UnresolvedHttpUpsert[]): number {
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO unresolved_http_calls
        (id, repo_url, file_path, line, method, url_template, client_library, reason, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        reason = excluded.reason,
        client_library = excluded.client_library,
        last_seen = excluded.last_seen
    `);
    const tx = this.db.transaction((items: readonly UnresolvedHttpUpsert[]) => {
      for (const r of items) {
        stmt.run(
          rowId(r), r.repoUrl, r.filePath, r.line, r.method,
          r.urlTemplate, r.clientLibrary, r.reason, now,
        );
      }
    });
    tx(rows);
    return rows.length;
  }

  list(repoUrl?: string, limit = 100): UnresolvedHttpRow[] {
    const rows = repoUrl
      ? this.db.prepare(
          'SELECT * FROM unresolved_http_calls WHERE repo_url = ? ORDER BY last_seen DESC LIMIT ?',
        ).all(repoUrl, limit) as Record<string, unknown>[]
      : this.db.prepare(
          'SELECT * FROM unresolved_http_calls ORDER BY last_seen DESC LIMIT ?',
        ).all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  deleteByRepo(repoUrl: string): number {
    const result = this.db.prepare(
      'DELETE FROM unresolved_http_calls WHERE repo_url = ?',
    ).run(repoUrl);
    return result.changes ?? 0;
  }
}

function mapRow(row: Record<string, unknown>): UnresolvedHttpRow {
  return {
    id: row['id'] as string,
    repoUrl: row['repo_url'] as string,
    filePath: row['file_path'] as string,
    line: row['line'] as number,
    method: row['method'] as string,
    urlTemplate: row['url_template'] as string,
    clientLibrary: row['client_library'] as string,
    reason: row['reason'] as string,
    lastSeen: row['last_seen'] as string,
  };
}
