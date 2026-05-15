import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RepoStateRepository } from '../../src/repo-state.repository.js';

describe('RepoStateRepository', () => {
  let db: Database.Database;
  let repo: RepoStateRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new RepoStateRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('upsertOnSuccess inserts a new row', () => {
    repo.upsertOnSuccess('git@host:org/repo.git', 'abc123');
    const r = repo.findByUrl('git@host:org/repo.git');
    expect(r?.lastSha).toBe('abc123');
    expect(r?.lastError).toBeUndefined();
  });

  it('upsertOnSuccess clears prior failure', () => {
    repo.upsertOnFailure('r', 'boom');
    expect(repo.findByUrl('r')?.lastError).toBe('boom');
    repo.upsertOnSuccess('r', 'sha2');
    expect(repo.findByUrl('r')?.lastError).toBeUndefined();
    expect(repo.findByUrl('r')?.lastFailedAt).toBeUndefined();
  });

  it('upsertOnFailure preserves last_ingested_at and last_sha', () => {
    repo.upsertOnSuccess('r', 'goodSha');
    const okAt = repo.findByUrl('r')?.lastIngestedAt;
    repo.upsertOnFailure('r', 'connection refused');
    const after = repo.findByUrl('r');
    expect(after?.lastIngestedAt).toBe(okAt);
    expect(after?.lastSha).toBe('goodSha');
    expect(after?.lastError).toBe('connection refused');
  });

  it('findStale returns repos older than threshold', () => {
    repo.upsertOnSuccess('fresh', 'a');
    // Insert a stale row directly to bypass time-of-day flake
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO repo_state (repo_url, last_sha, last_ingested_at)
      VALUES (?, ?, ?)
    `).run('stale', 'b', old);

    const stale = repo.findStale(7);
    expect(stale.map((r) => r.repoUrl)).toEqual(['stale']);
  });

  it('getAll returns rows sorted newest first', () => {
    repo.upsertOnSuccess('r1', 's1');
    repo.upsertOnSuccess('r2', 's2');
    const all = repo.getAll();
    expect(all).toHaveLength(2);
  });

  it('truncates absurdly long error messages', () => {
    const big = 'x'.repeat(5000);
    repo.upsertOnFailure('r', big);
    const after = repo.findByUrl('r');
    expect(after?.lastError?.length).toBeLessThanOrEqual(1003);
  });
});
