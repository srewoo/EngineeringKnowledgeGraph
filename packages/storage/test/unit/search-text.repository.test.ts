import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchTextRepository, sanitiseFtsQuery, type SearchTextRow } from '../../src/search-text.repository.js';

function row(overrides: Partial<SearchTextRow> = {}): SearchTextRow {
  return {
    label: 'Function',
    nodeId: 'fn:1',
    repoUrl: 'r1',
    name: 'compute proficiency',
    path: 'src/score.ts',
    body: 'compute the proficiency score for a user based on their answers',
    ...overrides,
  };
}

describe('SearchTextRepository', () => {
  let tempDir: string;
  let repo: SearchTextRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-bm25-'));
    repo = new SearchTextRepository(join(tempDir, 'fts.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes and finds by token', () => {
    repo.index([row()]);
    const hits = repo.searchBm25('proficiency');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.nodeId).toBe('fn:1');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('upsert is idempotent on conflicting node_id', () => {
    repo.index([row({ body: 'first version' })]);
    repo.index([row({ body: 'second version with proficiency' })]);
    expect(repo.countAll()).toBe(1);
    const hits = repo.searchBm25('proficiency');
    expect(hits).toHaveLength(1);
  });

  it('filters by label and repo', () => {
    repo.index([
      row({ nodeId: 'fn:1', label: 'Function', repoUrl: 'r1' }),
      row({ nodeId: 'doc:1', label: 'Doc', repoUrl: 'r1', name: 'README about proficiency', body: 'proficiency notes' }),
      row({ nodeId: 'fn:2', label: 'Function', repoUrl: 'r2' }),
    ]);
    const fnOnly = repo.searchBm25('proficiency', { label: 'Function' });
    expect(fnOnly.every((h) => h.label === 'Function')).toBe(true);

    const r1Only = repo.searchBm25('proficiency', { repoUrl: 'r1' });
    expect(r1Only.every((h) => h.repoUrl === 'r1')).toBe(true);
  });

  it('returns empty for queries that sanitise to nothing', () => {
    repo.index([row()]);
    expect(repo.searchBm25('')).toEqual([]);
    expect(repo.searchBm25('"')).toEqual([]);
    expect(repo.searchBm25('a')).toEqual([]); // single-char tokens dropped
  });

  it('deleteByRepo removes only matching rows', () => {
    repo.index([
      row({ nodeId: 'fn:1', repoUrl: 'r1' }),
      row({ nodeId: 'fn:2', repoUrl: 'r2' }),
    ]);
    expect(repo.deleteByRepo('r1')).toBe(1);
    expect(repo.countAll()).toBe(1);
    expect(repo.searchBm25('proficiency').every((h) => h.repoUrl === 'r2')).toBe(true);
  });

  it('respects k limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ nodeId: `fn:${i}`, body: 'proficiency score calculation' }));
    repo.index(rows);
    const hits = repo.searchBm25('proficiency', { k: 5 });
    expect(hits).toHaveLength(5);
  });

  it('survives FTS5 reserved characters in query', () => {
    repo.index([row({ body: 'compute the proficiency score' })]);
    const hits = repo.searchBm25('compute("proficiency")');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('sanitiseFtsQuery', () => {
  it('drops empty / single-char tokens', () => {
    expect(sanitiseFtsQuery('')).toBe('');
    expect(sanitiseFtsQuery('a b')).toBe('');
    expect(sanitiseFtsQuery('ab cd')).toBe('"ab" OR "cd"');
  });

  it('strips FTS operator chars', () => {
    expect(sanitiseFtsQuery('foo:bar')).toBe('"foo" OR "bar"');
    expect(sanitiseFtsQuery('"AND" hello')).toBe('"AND" OR "hello"');
  });
});
