import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteRepository } from '../../src/sqlite.repository.js';
import { UnresolvedHttpRepository } from '../../src/unresolved-http.repository.js';

describe('UnresolvedHttpRepository', () => {
  let sqlite: SqliteRepository;
  let repo: UnresolvedHttpRepository;

  beforeEach(() => {
    sqlite = new SqliteRepository(':memory:');
    repo = new UnresolvedHttpRepository(sqlite.getConnection());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('upsertMany inserts and is idempotent on (repo, file, line, method, url)', () => {
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'x.ts', line: 1, method: 'GET', urlTemplate: '{var}/u', clientLibrary: 'axios', reason: 'no-match' },
    ]);
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'x.ts', line: 1, method: 'GET', urlTemplate: '{var}/u', clientLibrary: 'axios', reason: 'fuzzy-failed' },
    ]);
    const rows = repo.list('r/a');
    expect(rows.length).toBe(1);
    expect(rows[0]?.reason).toBe('fuzzy-failed');
  });

  it('list scopes by repoUrl', () => {
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'a', line: 1, method: 'GET', urlTemplate: 'u1', clientLibrary: 'c', reason: 'r' },
      { repoUrl: 'r/b', filePath: 'b', line: 2, method: 'GET', urlTemplate: 'u2', clientLibrary: 'c', reason: 'r' },
    ]);
    expect(repo.list('r/a').length).toBe(1);
    expect(repo.list('r/b').length).toBe(1);
    expect(repo.list().length).toBe(2);
  });

  it('deleteByRepo wipes only the targeted repo', () => {
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'a', line: 1, method: 'GET', urlTemplate: 'u1', clientLibrary: 'c', reason: 'r' },
      { repoUrl: 'r/b', filePath: 'b', line: 2, method: 'GET', urlTemplate: 'u2', clientLibrary: 'c', reason: 'r' },
    ]);
    const removed = repo.deleteByRepo('r/a');
    expect(removed).toBe(1);
    expect(repo.list('r/a').length).toBe(0);
    expect(repo.list('r/b').length).toBe(1);
  });

  it('limit caps result rows', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      repoUrl: 'r', filePath: `f${i}`, line: i, method: 'GET',
      urlTemplate: `u${i}`, clientLibrary: 'c', reason: 'r',
    }));
    repo.upsertMany(rows);
    expect(repo.list('r', 3).length).toBe(3);
  });

  it('count returns totals globally and per repo (Item 3 resolution rate)', () => {
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'a', line: 1, method: 'GET', urlTemplate: 'u1', clientLibrary: 'c', reason: 'no-match' },
      { repoUrl: 'r/a', filePath: 'a', line: 2, method: 'POST', urlTemplate: 'u2', clientLibrary: 'c', reason: 'no-match' },
      { repoUrl: 'r/b', filePath: 'b', line: 1, method: 'GET', urlTemplate: 'u3', clientLibrary: 'c', reason: 'path-only-no-host-match' },
    ]);
    expect(repo.count()).toBe(3);
    expect(repo.count('r/a')).toBe(2);
    expect(repo.count('r/b')).toBe(1);
    expect(repo.count('r/missing')).toBe(0);
  });

  it('countByReason histograms reasons descending', () => {
    repo.upsertMany([
      { repoUrl: 'r/a', filePath: 'a', line: 1, method: 'GET', urlTemplate: 'u1', clientLibrary: 'c', reason: 'no-match' },
      { repoUrl: 'r/a', filePath: 'a', line: 2, method: 'POST', urlTemplate: 'u2', clientLibrary: 'c', reason: 'no-match' },
      { repoUrl: 'r/a', filePath: 'a', line: 3, method: 'PUT', urlTemplate: 'u3', clientLibrary: 'c', reason: 'path-only-no-host-match' },
    ]);
    const byReason = repo.countByReason('r/a');
    expect(byReason['no-match']).toBe(2);
    expect(byReason['path-only-no-host-match']).toBe(1);
  });
});
