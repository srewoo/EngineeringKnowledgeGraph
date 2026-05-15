import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SnapshotRepository } from '../../src/snapshot.repository.js';

function fresh(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

describe('SnapshotRepository', () => {
  it('save creates a new row when label is unseen', () => {
    const repo = new SnapshotRepository(fresh());
    const s = repo.save('2026-05', '{"a":1}');
    expect(s.label).toBe('2026-05');
    expect(s.payload).toBe('{"a":1}');
    expect(s.id).toMatch(/[0-9a-f-]{30,}/);
  });

  it('save with existing label overwrites payload (idempotent on label)', () => {
    const repo = new SnapshotRepository(fresh());
    const a = repo.save('m', '"old"');
    const b = repo.save('m', '"new"');
    expect(b.id).toBe(a.id);
    expect(repo.getByLabel('m')?.payload).toBe('"new"');
  });

  it('getByLabel returns undefined when missing', () => {
    const repo = new SnapshotRepository(fresh());
    expect(repo.getByLabel('absent')).toBeUndefined();
  });

  it('listLabels returns sorted distinct labels', () => {
    const repo = new SnapshotRepository(fresh());
    repo.save('z', '{}');
    repo.save('a', '{}');
    repo.save('m', '{}');
    expect(repo.listLabels()).toEqual(['a', 'm', 'z']);
  });

  it('latest returns most recent snapshot', async () => {
    const repo = new SnapshotRepository(fresh());
    repo.save('first', '{}');
    // Tiny gap to ensure created_at differs.
    await new Promise((r) => setTimeout(r, 5));
    const second = repo.save('second', '{}');
    expect(repo.latest()?.id).toBe(second.id);
  });

  it('rejects empty label', () => {
    const repo = new SnapshotRepository(fresh());
    expect(() => repo.save('', '{}')).toThrow();
  });
});
