/**
 * Feedback repository — thumbs-up/down on agent answers.
 *
 * SQLite-backed. Owns its `answer_feedback` table; safe to call on a shared DB.
 * Uses better-sqlite3 directly to keep storage package decoupled.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type FeedbackVerdict = 'up' | 'down';

export interface FeedbackRow {
  readonly id: string;
  readonly traceId: string;
  readonly question: string;
  readonly verdict: FeedbackVerdict;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface FeedbackInput {
  readonly traceId: string;
  readonly question: string;
  readonly verdict: FeedbackVerdict;
  readonly reason?: string;
}

export class FeedbackRepository {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS answer_feedback (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        question TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('up','down')),
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_trace ON answer_feedback(trace_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_verdict ON answer_feedback(verdict);
    `);
  }

  upsert(input: FeedbackInput): FeedbackRow {
    const row: FeedbackRow = {
      id: randomUUID(),
      traceId: input.traceId,
      question: input.question,
      verdict: input.verdict,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO answer_feedback (id, trace_id, question, verdict, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.traceId, row.question, row.verdict, row.reason ?? null, row.createdAt);
    return row;
  }

  listByVerdict(verdict: FeedbackVerdict, limit: number = 100): readonly FeedbackRow[] {
    const cap = Math.max(1, Math.min(limit, 1000));
    const rows = this.db.prepare(
      'SELECT * FROM answer_feedback WHERE verdict = ? ORDER BY created_at DESC LIMIT ?',
    ).all(verdict, cap) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  listByTrace(traceId: string): readonly FeedbackRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM answer_feedback WHERE trace_id = ? ORDER BY created_at DESC LIMIT 100',
    ).all(traceId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  countByVerdict(): { up: number; down: number } {
    const rows = this.db.prepare(
      "SELECT verdict, COUNT(*) AS n FROM answer_feedback GROUP BY verdict",
    ).all() as { verdict: FeedbackVerdict; n: number }[];
    const out = { up: 0, down: 0 };
    for (const r of rows) {
      if (r.verdict === 'up') out.up = Number(r.n);
      if (r.verdict === 'down') out.down = Number(r.n);
    }
    return out;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private mapRow(row: Record<string, unknown>): FeedbackRow {
    const reason = row['reason'] as string | null;
    return {
      id: row['id'] as string,
      traceId: row['trace_id'] as string,
      question: row['question'] as string,
      verdict: row['verdict'] as FeedbackVerdict,
      ...(reason ? { reason } : {}),
      createdAt: row['created_at'] as string,
    };
  }
}
