/**
 * SQLite tenant isolation tests (Phase 2 of ADR-006 bridge).
 *
 * Two tenants share one `ekg.db`; each ingestion job / bulk job writes
 * with its tenantId stamped. Reads scoped to a tenant see only that
 * tenant's rows. Pre-tenant rows (no tenant_id set) default to 'local'
 * and surface through the local tenant path.
 *
 * We also test the idempotent migration: dropping the column from a
 * test DB and re-initialising the repo re-adds it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRepository } from '../../src/sqlite.repository.js';

describe('SqliteRepository — tenant isolation', () => {
  let dir: string;
  let dbPath: string;
  let repo: SqliteRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ekg-sqlite-tenant-'));
    dbPath = join(dir, 'ekg.db');
    repo = new SqliteRepository(dbPath);
  });

  afterEach(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createJob stamps the supplied tenantId (default "local")', () => {
    const defaultJob = repo.createJob('https://gitlab/x/y.git', 'main');
    const acmeJob    = repo.createJob('https://gitlab/x/y.git', 'main', 'acme');

    // Pull raw rows via the underlying DB to inspect the column.
    const db = new Database(dbPath);
    try {
      const rows = db.prepare('SELECT id, tenant_id FROM ingestion_jobs').all() as Array<{ id: string; tenant_id: string }>;
      const byId = new Map(rows.map((r) => [r.id, r.tenant_id]));
      expect(byId.get(defaultJob.id)).toBe('local');
      expect(byId.get(acmeJob.id)).toBe('acme');
    } finally {
      db.close();
    }
  });

  it('listBulkJobs(tenantId) filters by tenant; without tenantId returns all', () => {
    const now = new Date().toISOString();
    repo.upsertBulkJob({
      id: 'job-acme', status: 'COMPLETED',
      totalDiscovered: 1, totalIngested: 1, totalFailed: 0, totalSkipped: 0,
      currentRepo: '', startedAt: now, updatedAt: now, payload: '{}',
      tenantId: 'acme',
    });
    repo.upsertBulkJob({
      id: 'job-widg', status: 'COMPLETED',
      totalDiscovered: 1, totalIngested: 1, totalFailed: 0, totalSkipped: 0,
      currentRepo: '', startedAt: now, updatedAt: now, payload: '{}',
      tenantId: 'widgetcorp',
    });
    repo.upsertBulkJob({
      id: 'job-local', status: 'COMPLETED',
      totalDiscovered: 1, totalIngested: 1, totalFailed: 0, totalSkipped: 0,
      currentRepo: '', startedAt: now, updatedAt: now, payload: '{}',
    });
    const acme = repo.listBulkJobs('acme').map((r) => r['id']);
    const widg = repo.listBulkJobs('widgetcorp').map((r) => r['id']);
    const all  = repo.listBulkJobs().map((r) => r['id']);
    expect(acme).toEqual(['job-acme']);
    expect(widg).toEqual(['job-widg']);
    expect(new Set(all)).toEqual(new Set(['job-acme', 'job-widg', 'job-local']));
  });

  it('getJobsByRepoForTenant filters even when repo URL collides across tenants', () => {
    const sharedUrl = 'https://gitlab/shared/repo.git';
    repo.createJob(sharedUrl, 'main', 'acme');
    repo.createJob(sharedUrl, 'main', 'widgetcorp');
    repo.createJob(sharedUrl, 'main'); // local

    expect(repo.getJobsByRepoForTenant(sharedUrl, 'acme')).toHaveLength(1);
    expect(repo.getJobsByRepoForTenant(sharedUrl, 'widgetcorp')).toHaveLength(1);
    expect(repo.getJobsByRepoForTenant(sharedUrl, 'local')).toHaveLength(1);
    // The unscoped read sees all three.
    expect(repo.getJobsByRepo(sharedUrl)).toHaveLength(3);
  });

  it('idempotent migration: re-instantiating the repo on the same file is a no-op', () => {
    repo.createJob('https://gitlab/a/b', 'main', 'acme');
    repo.close();
    // Re-open
    repo = new SqliteRepository(dbPath);
    const rows = repo.getJobsByRepoForTenant('https://gitlab/a/b', 'acme');
    expect(rows).toHaveLength(1);
  });

  it('migration adds tenant_id to a pre-Phase-2 DB without losing data', () => {
    repo.close();
    // Simulate a pre-Phase-2 DB: drop the column from a freshly created file.
    const fresh = new Database(dbPath);
    fresh.exec(`
      DROP TABLE IF EXISTS ingestion_jobs;
      CREATE TABLE ingestion_jobs (
        id TEXT PRIMARY KEY,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        status TEXT NOT NULL DEFAULT 'PENDING',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        commit_sha TEXT,
        files_processed INTEGER NOT NULL DEFAULT 0,
        nodes_created INTEGER NOT NULL DEFAULT 0,
        edges_created INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      INSERT INTO ingestion_jobs (id, repo_url, started_at) VALUES ('legacy-1', 'r', '${new Date().toISOString()}');
    `);
    fresh.close();

    // Re-open via repo — the migration must add tenant_id with default 'local'.
    repo = new SqliteRepository(dbPath);
    const cols = new Database(dbPath).prepare('PRAGMA table_info(ingestion_jobs)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
    // Legacy row is now scoped to 'local'.
    expect(repo.getJobsByRepoForTenant('r', 'local')).toHaveLength(1);
  });
});
