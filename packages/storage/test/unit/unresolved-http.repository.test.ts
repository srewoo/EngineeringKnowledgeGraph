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
});
