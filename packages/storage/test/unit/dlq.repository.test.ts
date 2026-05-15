import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteRepository } from '../../src/sqlite.repository.js';
import { DlqRepository } from '../../src/dlq.repository.js';

describe('DlqRepository', () => {
  let sqlite: SqliteRepository;
  let dlq: DlqRepository;
  let db: Database.Database;

  beforeEach(() => {
    sqlite = new SqliteRepository(':memory:');
    db = sqlite.getConnection();
    dlq = new DlqRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('upsert is idempotent on (bulkJobId, repoUrl)', () => {
    dlq.upsert({
      bulkJobId: 'bulk-1',
      repoUrl: 'https://git/x.git',
      repoName: 'x',
      errorCategory: 'NEO4J_LOCK',
      errorMessage: 'lock 1',
      attempts: 3,
    });
    dlq.upsert({
      bulkJobId: 'bulk-1',
      repoUrl: 'https://git/x.git',
      repoName: 'x',
      errorCategory: 'TIMEOUT',
      errorMessage: 'timeout 2',
      attempts: 5,
    });
    const rows = dlq.listUnresolved('bulk-1');
    expect(rows.length).toBe(1);
    expect(rows[0]?.errorCategory).toBe('TIMEOUT');
    expect(rows[0]?.errorMessage).toBe('timeout 2');
    expect(rows[0]?.attempts).toBe(5);
  });

  it('listUnresolved filters resolved rows and scopes by bulkJobId', () => {
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/a', repoName: 'a', errorCategory: 'TIMEOUT', errorMessage: 'e', attempts: 1 });
    dlq.upsert({ bulkJobId: 'b2', repoUrl: 'u/b', repoName: 'b', errorCategory: 'NEO4J_LOCK', errorMessage: 'e', attempts: 1 });
    expect(dlq.listUnresolved().length).toBe(2);
    expect(dlq.listUnresolved('b1').length).toBe(1);

    const id = dlq.idForRepo('b1', 'u/a');
    dlq.markResolved(id);
    expect(dlq.listUnresolved('b1').length).toBe(0);
    expect(dlq.listUnresolved().length).toBe(1);
  });

  it('countByCategory groups unresolved rows', () => {
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/1', repoName: '1', errorCategory: 'TIMEOUT', errorMessage: 'e', attempts: 1 });
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/2', repoName: '2', errorCategory: 'TIMEOUT', errorMessage: 'e', attempts: 1 });
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/3', repoName: '3', errorCategory: 'NEO4J_LOCK', errorMessage: 'e', attempts: 1 });
    dlq.upsert({ bulkJobId: 'b2', repoUrl: 'u/4', repoName: '4', errorCategory: 'PARSE_FAILED', errorMessage: 'e', attempts: 1 });

    const all = dlq.countByCategory();
    expect(all.TIMEOUT).toBe(2);
    expect(all.NEO4J_LOCK).toBe(1);
    expect(all.PARSE_FAILED).toBe(1);
    expect(all.UNKNOWN).toBe(0);

    const justB1 = dlq.countByCategory('b1');
    expect(justB1.TIMEOUT).toBe(2);
    expect(justB1.PARSE_FAILED).toBe(0);
  });

  it('listByCategory filters by category', () => {
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/1', repoName: '1', errorCategory: 'TIMEOUT', errorMessage: 'e', attempts: 1 });
    dlq.upsert({ bulkJobId: 'b1', repoUrl: 'u/2', repoName: '2', errorCategory: 'NEO4J_LOCK', errorMessage: 'e', attempts: 1 });
    expect(dlq.listByCategory('TIMEOUT').length).toBe(1);
    expect(dlq.listByCategory('NEO4J_LOCK', 'b1').length).toBe(1);
    expect(dlq.listByCategory('NEO4J_LOCK', 'b2').length).toBe(0);
  });
});
