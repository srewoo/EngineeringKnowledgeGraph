import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchTextRepository, type SearchTextRow } from '../../src/search-text.repository.js';

function row(over: Partial<SearchTextRow> = {}): SearchTextRow {
  return {
    label: 'Function',
    nodeId: 'fn:1',
    repoUrl: 'r1',
    name: 'compute proficiency',
    path: 'src/score.ts',
    body: 'compute the proficiency score',
    ...over,
  };
}

describe('SearchTextRepository — deletion', () => {
  let tempDir: string;
  let repo: SearchTextRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-bm25-del-'));
    repo = new SearchTextRepository(join(tempDir, 'fts.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('deleteByNodeIds removes only matching rows', () => {
    repo.index([
      row({ nodeId: 'fn:a' }),
      row({ nodeId: 'fn:b' }),
      row({ nodeId: 'fn:c' }),
    ]);
    expect(repo.deleteByNodeIds(['fn:a', 'fn:c'])).toBe(2);
    expect(repo.countAll()).toBe(1);
    expect(repo.searchBm25('proficiency').map((h) => h.nodeId)).toEqual(['fn:b']);
  });

  it('deleteByNodeIds returns 0 for empty input', () => {
    repo.index([row()]);
    expect(repo.deleteByNodeIds([])).toBe(0);
    expect(repo.countAll()).toBe(1);
  });

  it('deleteByNodeIds handles >500 ids', () => {
    const rows: SearchTextRow[] = [];
    for (let i = 0; i < 700; i++) rows.push(row({ nodeId: `n:${i}` }));
    repo.index(rows);
    expect(repo.countAll()).toBe(700);
    expect(repo.deleteByNodeIds(rows.map((r) => r.nodeId))).toBe(700);
    expect(repo.countAll()).toBe(0);
  });

  it('listNodeIdsByRepo returns distinct ids for the given repo', () => {
    repo.index([
      row({ nodeId: 'fn:a', repoUrl: 'r1' }),
      row({ nodeId: 'fn:b', repoUrl: 'r1' }),
      row({ nodeId: 'fn:c', repoUrl: 'r2' }),
    ]);
    expect(repo.listNodeIdsByRepo('r1').sort()).toEqual(['fn:a', 'fn:b']);
    expect(repo.listNodeIdsByRepo('r2')).toEqual(['fn:c']);
  });
});
