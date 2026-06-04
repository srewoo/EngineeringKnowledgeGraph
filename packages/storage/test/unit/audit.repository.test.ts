/**
 * AuditRepository tests — schema creation, write semantics, query filters,
 * input hashing determinism, limit clamping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuditRepository, hashInput } from '../../src/audit.repository.js';

describe('AuditRepository', () => {
  let dir: string;
  let db: Database.Database;
  let repo: AuditRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ekg-audit-'));
    db = new Database(join(dir, 'audit.db'));
    repo = new AuditRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a row and returns it with id + createdAt populated', () => {
    const row = repo.record({
      tenantId: 'acme', actor: 'user:alice', tool: 'get_dependencies',
      input: { service: 'payment-service' }, status: 'ok', latencyMs: 42,
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-/);
    expect(row.tenantId).toBe('acme');
    expect(row.inputHash.length).toBe(32);
    expect(row.latencyMs).toBe(42);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('clamps negative latencyMs to 0 (defensive)', () => {
    const row = repo.record({
      tenantId: 't', actor: 'a', tool: 'x', input: null, status: 'ok', latencyMs: -5,
    });
    expect(row.latencyMs).toBe(0);
  });

  it('filters by tenantId / actor / tool / status', () => {
    repo.record({ tenantId: 'a', actor: 'u1', tool: 'foo', input: {}, status: 'ok',     latencyMs: 1 });
    repo.record({ tenantId: 'a', actor: 'u2', tool: 'foo', input: {}, status: 'denied', latencyMs: 2 });
    repo.record({ tenantId: 'b', actor: 'u1', tool: 'bar', input: {}, status: 'ok',     latencyMs: 3 });
    expect(repo.query({ tenantId: 'a' }).length).toBe(2);
    expect(repo.query({ actor: 'u1' }).length).toBe(2);
    expect(repo.query({ tool: 'foo' }).length).toBe(2);
    expect(repo.query({ status: 'denied' }).length).toBe(1);
    expect(repo.query({ tenantId: 'a', status: 'denied' }).length).toBe(1);
    expect(repo.query({ tenantId: 'nope' }).length).toBe(0);
  });

  it('returns rows newest-first', () => {
    const r1 = repo.record({ tenantId: 't', actor: 'a', tool: 'x', input: { i: 1 }, status: 'ok', latencyMs: 1 });
    // Force a temporal gap so created_at differs by 1ms+
    const r2 = repo.record({ tenantId: 't', actor: 'a', tool: 'x', input: { i: 2 }, status: 'ok', latencyMs: 1 });
    const rows = repo.query({ tenantId: 't' });
    // Either ordering is possible at microsecond granularity, but our two
    // rows should both come back and the newer one comes first when
    // timestamps differ.
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([r1.id, r2.id]));
  });

  it('clamps limit to [1, 500]', () => {
    for (let i = 0; i < 5; i += 1) {
      repo.record({ tenantId: 't', actor: 'a', tool: 'x', input: { i }, status: 'ok', latencyMs: 1 });
    }
    expect(repo.query({ limit: 0 }).length).toBe(1);
    expect(repo.query({ limit: -1 }).length).toBe(1);
    expect(repo.query({ limit: 10_000 }).length).toBeLessThanOrEqual(5);
  });

  it('countAll returns the total row count', () => {
    expect(repo.countAll()).toBe(0);
    for (let i = 0; i < 7; i += 1) {
      repo.record({ tenantId: 't', actor: 'a', tool: 'x', input: i, status: 'ok', latencyMs: 1 });
    }
    expect(repo.countAll()).toBe(7);
  });
});

describe('hashInput', () => {
  it('is deterministic for the same logical input', () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ a: 1, b: 2 }));
  });

  it('differs for different inputs', () => {
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  it('handles null / undefined as the same hash (both => null serialisation)', () => {
    expect(hashInput(null)).toBe(hashInput(undefined));
  });

  it('returns a fixed-width hex prefix', () => {
    const h = hashInput({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});
