/**
 * AgentSessionRepository — multi-turn conversation state for `@ekg/agent`.
 *
 * Sessions are operator-driven: a caller starts a session, threads `sessionId`
 * through subsequent `agent.ask` calls, and explicitly ends it. State is
 * stored as opaque JSON (messages + seenIds + metadata) — the agent owns the
 * shape; this repo only serialises.
 *
 * Schema is created lazily on construction. Shares the SQLite connection with
 * `SqliteRepository` (single-writer WAL).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '@ekg/shared';

export interface AgentSessionRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly messages: string; // JSON-stringified Message[]
  readonly seenIds: string;  // JSON-stringified string[]
  readonly metadata: string | undefined;
}

export interface AgentSessionUpdate {
  readonly messages?: string;
  readonly seenIds?: string;
  readonly metadata?: string;
}

export class AgentSessionRepository {
  private readonly db: Database.Database;
  private readonly logger: Logger;

  constructor(db: Database.Database) {
    this.db = db;
    this.logger = createLogger({ service: 'agent-session-repository' });
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        messages TEXT NOT NULL,
        seen_ids TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_used
        ON agent_sessions(last_used_at);
    `);
  }

  create(): { readonly sessionId: string } {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_sessions
          (session_id, created_at, last_used_at, messages, seen_ids, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, now, now, '[]', '[]', null);
    this.logger.info({ sessionId }, 'agent session created');
    return { sessionId };
  }

  get(sessionId: string): AgentSessionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sessionId: row['session_id'] as string,
      createdAt: row['created_at'] as string,
      lastUsedAt: row['last_used_at'] as string,
      messages: row['messages'] as string,
      seenIds: row['seen_ids'] as string,
      metadata: (row['metadata'] as string | null) ?? undefined,
    };
  }

  update(sessionId: string, fields: AgentSessionUpdate): void {
    const now = new Date().toISOString();
    const sets: string[] = ['last_used_at = ?'];
    const vals: (string | null)[] = [now];
    if (fields.messages !== undefined) {
      sets.push('messages = ?');
      vals.push(fields.messages);
    }
    if (fields.seenIds !== undefined) {
      sets.push('seen_ids = ?');
      vals.push(fields.seenIds);
    }
    if (fields.metadata !== undefined) {
      sets.push('metadata = ?');
      vals.push(fields.metadata);
    }
    vals.push(sessionId);
    this.db
      .prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE session_id = ?`)
      .run(...vals);
  }

  delete(sessionId: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM agent_sessions WHERE session_id = ?`)
      .run(sessionId);
    return info.changes > 0;
  }

  /**
   * Delete sessions whose `last_used_at` is older than `olderThanDays`.
   * Returns the number of rows deleted.
   */
  prune(olderThanDays = 30): number {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error('prune: olderThanDays must be a non-negative finite number');
    }
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM agent_sessions WHERE last_used_at < ?`)
      .run(cutoff);
    if (info.changes > 0) {
      this.logger.info({ pruned: info.changes, cutoff }, 'pruned stale agent sessions');
    }
    return info.changes;
  }
}
