/**
 * SnapshotRepository — persists architecture-graph snapshots in SQLite.
 *
 * Snapshots are keyed by a human label (e.g. "2026-05-monthly"). Saving with
 * an existing label overwrites the prior payload — re-running a label is
 * idempotent. The payload is stored as a JSON string; callers parse on read.
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface Snapshot {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly payload: string;
}

export class SnapshotRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_snapshots (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_created
        ON graph_snapshots(created_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_label
        ON graph_snapshots(label);
    `);
  }

  save(label: string, payload: string): Snapshot {
    if (!label) throw new Error('snapshot label must be non-empty');
    const existing = this.getByLabel(label);
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(`
        UPDATE graph_snapshots
        SET payload = ?, created_at = ?
        WHERE id = ?
      `).run(payload, now, existing.id);
      return { id: existing.id, label, createdAt: now, payload };
    }
    const snap: Snapshot = {
      id: randomUUID(),
      label,
      createdAt: now,
      payload,
    };
    this.db.prepare(`
      INSERT INTO graph_snapshots (id, label, created_at, payload)
      VALUES (?, ?, ?, ?)
    `).run(snap.id, snap.label, snap.createdAt, snap.payload);
    return snap;
  }

  getByLabel(label: string): Snapshot | undefined {
    const row = this.db.prepare(
      'SELECT * FROM graph_snapshots WHERE label = ? ORDER BY created_at DESC LIMIT 1',
    ).get(label) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getById(id: string): Snapshot | undefined {
    const row = this.db.prepare(
      'SELECT * FROM graph_snapshots WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listLabels(): readonly string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT label FROM graph_snapshots ORDER BY label ASC',
    ).all() as Array<{ label: string }>;
    return rows.map((r) => r.label);
  }

  latest(): Snapshot | undefined {
    const row = this.db.prepare(
      'SELECT * FROM graph_snapshots ORDER BY created_at DESC LIMIT 1',
    ).get() as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * List snapshots whose label starts with the given prefix, newest first.
   * Used by `snapshot_prune` to enumerate auto-* snapshots.
   */
  listByPrefix(prefix: string, limit = 1000): readonly Snapshot[] {
    const rows = this.db.prepare(
      `SELECT * FROM graph_snapshots
       WHERE label LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(`${prefix}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  deleteById(id: string): boolean {
    const info = this.db.prepare('DELETE FROM graph_snapshots WHERE id = ?').run(id);
    return info.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Snapshot {
    return {
      id: row['id'] as string,
      label: row['label'] as string,
      createdAt: row['created_at'] as string,
      payload: row['payload'] as string,
    };
  }
}
