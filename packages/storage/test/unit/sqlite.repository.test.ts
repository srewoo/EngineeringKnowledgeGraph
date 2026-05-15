import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteRepository } from '../../src/sqlite.repository.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('SqliteRepository', () => {
  let repo: SqliteRepository;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-test-'));
    repo = new SqliteRepository(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('ingestion jobs', () => {
    it('should create a job with PENDING status', () => {
      const job = repo.createJob('https://github.com/test/repo', 'main');

      expect(job.id).toBeDefined();
      expect(job.repoUrl).toBe('https://github.com/test/repo');
      expect(job.branch).toBe('main');
      expect(job.status).toBe('PENDING');
      expect(job.filesProcessed).toBe(0);
    });

    it('should retrieve a job by ID', () => {
      const created = repo.createJob('https://github.com/test/repo', 'main');
      const found = repo.getJobById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.repoUrl).toBe(created.repoUrl);
    });

    it('should return undefined for non-existent job ID', () => {
      const found = repo.getJobById('non-existent-id');
      expect(found).toBeUndefined();
    });

    it('should update job status with details', () => {
      const job = repo.createJob('https://github.com/test/repo', 'main');

      repo.updateJobStatus(job.id, 'COMPLETED', {
        commitSha: 'abc123',
        filesProcessed: 42,
        nodesCreated: 100,
        edgesCreated: 75,
      });

      const updated = repo.getJobById(job.id);
      expect(updated?.status).toBe('COMPLETED');
      expect(updated?.commitSha).toBe('abc123');
      expect(updated?.filesProcessed).toBe(42);
      expect(updated?.nodesCreated).toBe(100);
      expect(updated?.edgesCreated).toBe(75);
      expect(updated?.completedAt).toBeDefined();
    });

    it('should update job status to FAILED with error', () => {
      const job = repo.createJob('https://github.com/test/repo', 'main');

      repo.updateJobStatus(job.id, 'FAILED', {
        error: 'Clone failed: auth error',
      });

      const updated = repo.getJobById(job.id);
      expect(updated?.status).toBe('FAILED');
      expect(updated?.error).toBe('Clone failed: auth error');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should get jobs by repo URL in descending order', () => {
      repo.createJob('https://github.com/test/repo', 'main');
      repo.createJob('https://github.com/test/repo', 'main');
      repo.createJob('https://github.com/other/repo', 'main');

      const jobs = repo.getJobsByRepo('https://github.com/test/repo');
      expect(jobs).toHaveLength(2);
    });

    it('should get the latest job by repo', () => {
      const first = repo.createJob('https://github.com/test/repo', 'main');
      const second = repo.createJob('https://github.com/test/repo', 'main');

      const latest = repo.getLatestJobByRepo('https://github.com/test/repo');
      expect(latest?.id).toBe(second.id);
    });

    it('should track last commit SHA from completed jobs', () => {
      const job = repo.createJob('https://github.com/test/repo', 'main');
      repo.updateJobStatus(job.id, 'COMPLETED', { commitSha: 'def456' });

      const sha = repo.getLastCommitSha('https://github.com/test/repo');
      expect(sha).toBe('def456');
    });

    it('should return undefined for last commit SHA when no completed jobs exist', () => {
      repo.createJob('https://github.com/test/repo', 'main');
      const sha = repo.getLastCommitSha('https://github.com/test/repo');
      expect(sha).toBeUndefined();
    });
  });

  describe('file metadata', () => {
    const sampleFile = {
      path: 'src/index.ts',
      repoUrl: 'https://github.com/test/repo',
      hash: 'sha256-abc123',
      language: 'typescript',
      lastParsedAt: new Date().toISOString(),
    };

    it('should upsert and retrieve file metadata', () => {
      repo.upsertFileMetadata(sampleFile);
      const found = repo.getFileMetadata(sampleFile.path, sampleFile.repoUrl);

      expect(found).toBeDefined();
      expect(found?.path).toBe(sampleFile.path);
      expect(found?.hash).toBe(sampleFile.hash);
    });

    it('should update existing file metadata on upsert', () => {
      repo.upsertFileMetadata(sampleFile);
      repo.upsertFileMetadata({ ...sampleFile, hash: 'sha256-updated' });

      const found = repo.getFileMetadata(sampleFile.path, sampleFile.repoUrl);
      expect(found?.hash).toBe('sha256-updated');
    });

    it('should return undefined for non-existent file', () => {
      const found = repo.getFileMetadata('nonexistent.ts', 'https://example.com');
      expect(found).toBeUndefined();
    });

    it('should get all files by repo', () => {
      repo.upsertFileMetadata(sampleFile);
      repo.upsertFileMetadata({ ...sampleFile, path: 'src/utils.ts' });

      const files = repo.getFilesByRepo(sampleFile.repoUrl);
      expect(files).toHaveLength(2);
    });

    it('should delete specific file metadata', () => {
      repo.upsertFileMetadata(sampleFile);
      repo.deleteFileMetadata(sampleFile.path, sampleFile.repoUrl);

      const found = repo.getFileMetadata(sampleFile.path, sampleFile.repoUrl);
      expect(found).toBeUndefined();
    });

    it('should delete all files for a repo', () => {
      repo.upsertFileMetadata(sampleFile);
      repo.upsertFileMetadata({ ...sampleFile, path: 'src/utils.ts' });
      repo.deleteFilesByRepo(sampleFile.repoUrl);

      const files = repo.getFilesByRepo(sampleFile.repoUrl);
      expect(files).toHaveLength(0);
    });
  });
});
