/**
 * Audit log repository (Phase 1 of ADR-006 bridge).
 *
 * Records every MCP tool invocation in hosted mode so operators can
 * answer "who asked what when" without LLM provider logs. In local mode
 * the repository is still constructed, but writes go through `record()`
 * which the caller may choose to skip — the local default is to skip.
 *
 * Schema is intentionally minimal:
 *   - tenantId   — required; stamped from request context
 *   - actor      — auth-proxy-supplied subject (user id or service token)
 *   - tool       — MCP tool name (e.g. `get_dependencies`)
 *   - inputHash  — sha256 of redacted args; never the raw args themselves
 *   - status     — 'ok' | 'error' | 'denied'
 *   - latencyMs  — durationN until response
 *   - createdAt  — ISO timestamp
 *
 * We hash inputs rather than store them: arguments to graph queries often
 * include service names that are themselves confidential to the tenant.
 * Operators who need to debug a specific call have the hash + timestamp
 * to correlate with structured logs (which redact value strings).
 *
 * For the "raw args needed for support" case, a separate operator-only
 * tool can store redacted args under a key tied to the audit id — that's
 * future work; the schema reserves no field for it today.
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditRow {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly tool: string;
  readonly inputHash: string;
  readonly status: AuditStatus;
  readonly latencyMs: number;
  readonly createdAt: string;
}

export interface AuditWriteInput {
  readonly tenantId: string;
  readonly actor: string;
  readonly tool: string;
  readonly input: unknown;
  readonly status: AuditStatus;
  readonly latencyMs: number;
}

export interface AuditQueryOptions {
  readonly tenantId?: string;
  readonly actor?: string;
  readonly tool?: string;
  readonly status?: AuditStatus;
  /** ISO timestamp lower bound, inclusive. */
  readonly fromIso?: string;
  /** ISO timestamp upper bound, exclusive. */
  readonly toIso?: string;
  readonly limit?: number;
}

const MAX_QUERY_LIMIT = 500;

export class AuditRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied')),
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_tenant_time  ON audit_log(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_actor_time   ON audit_log(actor, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_tool_time    ON audit_log(tool, created_at DESC);
    `);
  }

  /** Append a single audit row. Throws only on DB errors — never validates content. */
  record(entry: AuditWriteInput): AuditRow {
    const row: AuditRow = {
      id: randomUUID(),
      tenantId: entry.tenantId,
      actor: entry.actor,
      tool: entry.tool,
      inputHash: hashInput(entry.input),
      status: entry.status,
      latencyMs: Math.max(0, Math.floor(entry.latencyMs)),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO audit_log (id, tenant_id, actor, tool, input_hash, status, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.tenantId, row.actor, row.tool, row.inputHash, row.status, row.latencyMs, row.createdAt);
    return row;
  }

  /**
   * Query rows with optional filters. Returns most-recent first.
   * `limit` is clamped to [1, 500] — the table is meant for incident
   * triage, not bulk export.
   */
  query(options: AuditQueryOptions = {}): readonly AuditRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.tenantId) { where.push('tenant_id = ?'); params.push(options.tenantId); }
    if (options.actor)    { where.push('actor = ?');     params.push(options.actor); }
    if (options.tool)     { where.push('tool = ?');      params.push(options.tool); }
    if (options.status)   { where.push('status = ?');    params.push(options.status); }
    if (options.fromIso)  { where.push('created_at >= ?'); params.push(options.fromIso); }
    if (options.toIso)    { where.push('created_at < ?');  params.push(options.toIso); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(options.limit ?? 100, MAX_QUERY_LIMIT));
    const rows = this.db.prepare(`
      SELECT id, tenant_id AS tenantId, actor, tool, input_hash AS inputHash,
             status, latency_ms AS latencyMs, created_at AS createdAt
      FROM audit_log
      ${clause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit) as AuditRow[];
    return rows;
  }

  countAll(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number };
    return r.c;
  }
}

/**
 * Pure: deterministic sha256 of a JSON-stringified input. Exported so
 * callers can stamp the same hash on a separate non-PII trace channel
 * for correlation.
 */
export function hashInput(input: unknown): string {
  let serialised: string;
  try { serialised = JSON.stringify(input ?? null); } catch { serialised = '<unserializable>'; }
  return createHash('sha256').update(serialised).digest('hex').slice(0, 32);
}
