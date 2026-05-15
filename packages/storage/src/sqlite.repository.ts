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
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS file_metadata (
        path TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        last_parsed_at TEXT NOT NULL,
        PRIMARY KEY (path, repo_url)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_repo_url
        ON ingestion_jobs(repo_url);

      CREATE INDEX IF NOT EXISTS idx_jobs_status
        ON ingestion_jobs(status);

      CREATE INDEX IF NOT EXISTS idx_files_repo_url
        ON file_metadata(repo_url);

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
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status
        ON bulk_jobs(status);
    `);
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
  }): void {
    this.db.prepare(`
      INSERT INTO bulk_jobs
        (id, status, total_discovered, total_ingested, total_failed, total_skipped,
         current_repo, started_at, updated_at, completed_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    `).run(
      payload.id, payload.status,
      payload.totalDiscovered, payload.totalIngested, payload.totalFailed, payload.totalSkipped,
      payload.currentRepo, payload.startedAt, payload.updatedAt,
      payload.completedAt ?? null, payload.payload,
    );
  }

  getBulkJob(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  listBulkJobs(): readonly Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM bulk_jobs ORDER BY started_at DESC').all() as Record<string, unknown>[];
  }

  // -- Ingestion Jobs --

  createJob(repoUrl: string, branch: string): IngestionJob {
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
      INSERT INTO ingestion_jobs (id, repo_url, branch, status, started_at, files_processed, nodes_created, edges_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.repoUrl, job.branch, job.status, job.startedAt, 0, 0, 0);

    this.logger.info({ jobId: job.id, repoUrl }, 'Ingestion job created');
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

  upsertFileMetadata(metadata: FileMetadata): void {
    this.db.prepare(`
      INSERT INTO file_metadata (path, repo_url, hash, language, last_parsed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (path, repo_url) DO UPDATE SET
        hash = excluded.hash,
        language = excluded.language,
        last_parsed_at = excluded.last_parsed_at
    `).run(
      metadata.path,
      metadata.repoUrl,
      metadata.hash,
      metadata.language,
      metadata.lastParsedAt,
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
