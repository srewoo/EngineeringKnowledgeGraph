/**
 * SQLite repository for ingestion job tracking and file metadata.
 *
 * Handles all operational/metadata storage. The graph DB (Neo4j) handles
 * knowledge relationships; this handles "what have we processed, when, and
 * what was the result."
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@ekg/shared';
import type { IngestionJob, IngestionStatus, FileMetadata, Logger } from '@ekg/shared';

export class SqliteRepository {
  private readonly db: Database.Database;
  private readonly logger: Logger;

  constructor(dbPath: string) {
    this.logger = createLogger({ service: 'sqlite-repository' });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initTables();
    this.logger.info({ dbPath }, 'SQLite database initialised');
  }

  private initTables(): void {
    // Step 1 — table DDL only (idempotent CREATE TABLE IF NOT EXISTS).
    // Tenant_id default 'local' ensures backwards-compat for fresh DBs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_jobs (
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
        error TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS file_metadata (
        path TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        last_parsed_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (path, repo_url, tenant_id)
      );

      CREATE TABLE IF NOT EXISTS bulk_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        total_discovered INTEGER NOT NULL DEFAULT 0,
        total_ingested INTEGER NOT NULL DEFAULT 0,
        total_failed INTEGER NOT NULL DEFAULT 0,
        total_skipped INTEGER NOT NULL DEFAULT 0,
        current_repo TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        tenant_id TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS dead_letter_repos (
        id TEXT PRIMARY KEY,
        bulk_job_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        error_category TEXT NOT NULL,
        error_message TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        first_failed_at TEXT NOT NULL,
        last_failed_at TEXT NOT NULL,
        resolved_at TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'local'
      );
    `);

    // Step 2 — Phase 2 idempotent column migration for pre-tenant DBs.
    // Must run BEFORE any CREATE INDEX that references tenant_id.
    this.addTenantIdColumnIfMissing('ingestion_jobs');
    this.addTenantIdColumnIfMissing('file_metadata');
    this.addTenantIdColumnIfMissing('bulk_jobs');
    this.addTenantIdColumnIfMissing('dead_letter_repos');

    // Step 3 — indexes (safe because the columns now exist).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_repo_url       ON ingestion_jobs(repo_url);
      CREATE INDEX IF NOT EXISTS idx_jobs_status         ON ingestion_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_tenant         ON ingestion_jobs(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_files_repo_url      ON file_metadata(repo_url);
      CREATE INDEX IF NOT EXISTS idx_files_tenant        ON file_metadata(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status    ON bulk_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_bulk_jobs_tenant    ON bulk_jobs(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_dlq_bulk_job        ON dead_letter_repos(bulk_job_id);
      CREATE INDEX IF NOT EXISTS idx_dlq_unresolved      ON dead_letter_repos(resolved_at) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_dlq_tenant          ON dead_letter_repos(tenant_id);
    `);
  }

  /**
   * Idempotent migration helper — adds `tenant_id` (default 'local') if a
   * pre-Phase-2 SQLite file is missing the column. Safe to run on every
   * boot; cheap pragma check + no-op when column already exists.
   */
  private addTenantIdColumnIfMissing(table: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'tenant_id')) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'`);
  }

  // -- Bulk Jobs --

  upsertBulkJob(payload: {
    id: string;
    status: string;
    totalDiscovered: number;
    totalIngested: number;
    totalFailed: number;
    totalSkipped: number;
    currentRepo: string;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    payload: string;
    /** Phase 2 multi-tenant — defaults to 'local'. */
    tenantId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO bulk_jobs
        (id, status, total_discovered, total_ingested, total_failed, total_skipped,
         current_repo, started_at, updated_at, completed_at, payload, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status,
        total_discovered = excluded.total_discovered,
        total_ingested = excluded.total_ingested,
        total_failed = excluded.total_failed,
        total_skipped = excluded.total_skipped,
        current_repo = excluded.current_repo,
        updated_at = excluded.updated_at,
        completed_at = COALESCE(excluded.completed_at, bulk_jobs.completed_at),
        payload = excluded.payload
        -- tenant_id is set at INSERT time only; never updated by upsert.
    `).run(
      payload.id, payload.status,
      payload.totalDiscovered, payload.totalIngested, payload.totalFailed, payload.totalSkipped,
      payload.currentRepo, payload.startedAt, payload.updatedAt,
      payload.completedAt ?? null, payload.payload, payload.tenantId ?? 'local',
    );
  }

  getBulkJob(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  listBulkJobs(tenantId?: string): readonly Record<string, unknown>[] {
    // Phase 2 multi-tenant: explicit tenantId scopes; omitting it returns
    // all rows (admin path). Hosted-mode callers always pass the request
    // tenantId so they never see cross-tenant rows.
    if (tenantId) {
      return this.db
        .prepare('SELECT * FROM bulk_jobs WHERE tenant_id = ? ORDER BY started_at DESC')
        .all(tenantId) as Record<string, unknown>[];
    }
    return this.db.prepare('SELECT * FROM bulk_jobs ORDER BY started_at DESC').all() as Record<string, unknown>[];
  }

  /**
   * Phase 2 multi-tenant: scoped variant of `getJobsByRepo` that filters
   * by tenant. Existing `getJobsByRepo` stays as the admin/local path.
   */
  getJobsByRepoForTenant(repoUrl: string, tenantId: string): readonly IngestionJob[] {
    const rows = this.db.prepare(
      'SELECT * FROM ingestion_jobs WHERE repo_url = ? AND tenant_id = ? ORDER BY started_at DESC, rowid DESC',
    ).all(repoUrl, tenantId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToJob(row));
  }

  // -- Ingestion Jobs --

  /**
   * Phase 2 multi-tenant: `tenantId` defaults to `'local'` so existing
   * callers keep working. Hosted-mode callers pass it from the request
   * context.
   */
  createJob(repoUrl: string, branch: string, tenantId: string = 'local'): IngestionJob {
    const job: IngestionJob = {
      id: randomUUID(),
      repoUrl,
      branch,
      status: 'PENDING',
      startedAt: new Date().toISOString(),
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
    };

    this.db.prepare(`
      INSERT INTO ingestion_jobs (id, repo_url, branch, status, started_at, files_processed, nodes_created, edges_created, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.repoUrl, job.branch, job.status, job.startedAt, 0, 0, 0, tenantId);

    this.logger.info({ jobId: job.id, repoUrl, tenantId }, 'Ingestion job created');
    return job;
  }

  updateJobStatus(
    jobId: string,
    status: IngestionStatus,
    details?: Partial<Pick<IngestionJob, 'commitSha' | 'filesProcessed' | 'nodesCreated' | 'edgesCreated' | 'error'>>,
  ): void {
    const completedAt = status === 'COMPLETED' || status === 'FAILED'
      ? new Date().toISOString()
      : null;

    this.db.prepare(`
      UPDATE ingestion_jobs SET
        status = ?,
        completed_at = COALESCE(?, completed_at),
        commit_sha = COALESCE(?, commit_sha),
        files_processed = COALESCE(?, files_processed),
        nodes_created = COALESCE(?, nodes_created),
        edges_created = COALESCE(?, edges_created),
        error = COALESCE(?, error)
      WHERE id = ?
    `).run(
      status,
      completedAt,
      details?.commitSha ?? null,
      details?.filesProcessed ?? null,
      details?.nodesCreated ?? null,
      details?.edgesCreated ?? null,
      details?.error ?? null,
      jobId,
    );

    this.logger.info({ jobId, status }, 'Job status updated');
  }

  getJobById(jobId: string): IngestionJob | undefined {
    const row = this.db.prepare(
      'SELECT * FROM ingestion_jobs WHERE id = ?',
    ).get(jobId) as Record<string, unknown> | undefined;

    return row ? this.mapRowToJob(row) : undefined;
  }

  getJobsByRepo(repoUrl: string): readonly IngestionJob[] {
    const rows = this.db.prepare(
      'SELECT * FROM ingestion_jobs WHERE repo_url = ? ORDER BY started_at DESC, rowid DESC',
    ).all(repoUrl) as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToJob(row));
  }

  getLatestJobByRepo(repoUrl: string): IngestionJob | undefined {
    const row = this.db.prepare(
      'SELECT * FROM ingestion_jobs WHERE repo_url = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    ).get(repoUrl) as Record<string, unknown> | undefined;

    return row ? this.mapRowToJob(row) : undefined;
  }

  // -- File Metadata --

  upsertFileMetadata(metadata: FileMetadata, tenantId: string = 'local'): void {
    // Phase 2: PRIMARY KEY is now (path, repo_url, tenant_id) — the
    // ON CONFLICT clause must match that exact composite key.
    this.db.prepare(`
      INSERT INTO file_metadata (path, repo_url, hash, language, last_parsed_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (path, repo_url, tenant_id) DO UPDATE SET
        hash = excluded.hash,
        language = excluded.language,
        last_parsed_at = excluded.last_parsed_at
    `).run(
      metadata.path,
      metadata.repoUrl,
      metadata.hash,
      metadata.language,
      metadata.lastParsedAt,
      tenantId,
    );
  }

  getFileMetadata(path: string, repoUrl: string): FileMetadata | undefined {
    const row = this.db.prepare(
      'SELECT * FROM file_metadata WHERE path = ? AND repo_url = ?',
    ).get(path, repoUrl) as Record<string, unknown> | undefined;

    return row ? this.mapRowToFile(row) : undefined;
  }

  getFilesByRepo(repoUrl: string): readonly FileMetadata[] {
    const rows = this.db.prepare(
      'SELECT * FROM file_metadata WHERE repo_url = ?',
    ).all(repoUrl) as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToFile(row));
  }

  deleteFileMetadata(path: string, repoUrl: string): void {
    this.db.prepare(
      'DELETE FROM file_metadata WHERE path = ? AND repo_url = ?',
    ).run(path, repoUrl);
  }

  deleteFilesByRepo(repoUrl: string): void {
    this.db.prepare(
      'DELETE FROM file_metadata WHERE repo_url = ?',
    ).run(repoUrl);
  }

  // -- Utilities --

  /**
   * Get all repos whose latest ingestion job FAILED.
   * Returns one row per unique repo (most recent failed job only).
   */
  getFailedJobs(): readonly IngestionJob[] {
    const rows = this.db.prepare(`
      SELECT j.*
      FROM ingestion_jobs j
      INNER JOIN (
        SELECT repo_url, MAX(started_at) as max_started
        FROM ingestion_jobs
        GROUP BY repo_url
      ) latest ON j.repo_url = latest.repo_url AND j.started_at = latest.max_started
      WHERE j.status = 'FAILED'
      ORDER BY j.started_at DESC
    `).all() as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToJob(row));
  }

  getLastCommitSha(repoUrl: string): string | undefined {
    const row = this.db.prepare(
      'SELECT commit_sha FROM ingestion_jobs WHERE repo_url = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
    ).get(repoUrl, 'COMPLETED') as { commit_sha: string } | undefined;

    return row?.commit_sha ?? undefined;
  }

  close(): void {
    this.db.close();
    this.logger.info('SQLite database closed');
  }

  /**
   * Expose the underlying connection for adjacent repositories
   * (e.g. RepoStateRepository, FeedbackRepository) that share the DB file.
   * Avoids opening multiple connections to the same SQLite file.
   */
  getConnection(): Database.Database {
    return this.db;
  }

  // -- Row Mappers --

  private mapRowToJob(row: Record<string, unknown>): IngestionJob {
    return {
      id: row['id'] as string,
      repoUrl: row['repo_url'] as string,
      branch: row['branch'] as string,
      status: row['status'] as IngestionStatus,
      startedAt: row['started_at'] as string,
      completedAt: (row['completed_at'] as string) ?? undefined,
      commitSha: (row['commit_sha'] as string) ?? undefined,
      filesProcessed: row['files_processed'] as number,
      nodesCreated: row['nodes_created'] as number,
      edgesCreated: row['edges_created'] as number,
      error: (row['error'] as string) ?? undefined,
    };
  }

  private mapRowToFile(row: Record<string, unknown>): FileMetadata {
    return {
      path: row['path'] as string,
      repoUrl: row['repo_url'] as string,
      hash: row['hash'] as string,
      language: row['language'] as string,
      lastParsedAt: row['last_parsed_at'] as string,
    };
  }
}
