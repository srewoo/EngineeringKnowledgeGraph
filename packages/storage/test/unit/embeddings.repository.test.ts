import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingsRepository } from '../../src/embeddings.repository.js';

function vec(values: readonly number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function asF32(values: readonly number[]): Float32Array {
  return new Float32Array(values);
}

describe('EmbeddingsRepository', () => {
  let tempDir: string;
  let repo: EmbeddingsRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-emb-repo-'));
    repo = new EmbeddingsRepository(join(tempDir, 'emb.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts and finds by content hash', () => {
    repo.upsert([{
      id: 'Function:fn:1',
      label: 'Function',
      nodeId: 'fn:1',
      repoUrl: 'r1',
      contentHash: 'hash-a',
      provider: 'ollama',
      model: 'nomic',
      dimensions: 3,
      vector: vec([1, 0, 0]),
      textUsed: 'sig',
      createdAt: new Date().toISOString(),
    }]);

    const found = repo.findByContentHash('hash-a');
    expect(found).toBeDefined();
    expect(found?.nodeId).toBe('fn:1');
  });

  it('upsert is idempotent on conflicting id', () => {
    const base = {
      id: 'Function:fn:1',
      label: 'Function',
      nodeId: 'fn:1',
      repoUrl: 'r1',
      contentHash: 'h1',
      provider: 'ollama',
      model: 'nomic',
      dimensions: 3,
      vector: vec([1, 0, 0]),
      textUsed: 'first',
      createdAt: new Date().toISOString(),
    };
    repo.upsert([base]);
    repo.upsert([{ ...base, contentHash: 'h2', textUsed: 'second' }]);

    expect(repo.countAll()).toBe(1);
    expect(repo.findByContentHash('h1')).toBeUndefined();
    expect(repo.findByContentHash('h2')?.textUsed).toBe('second');
  });

  it('searchSimilar ranks by cosine similarity', () => {
    const now = new Date().toISOString();
    repo.upsert([
      {
        id: 'A', label: 'Function', nodeId: 'a', repoUrl: 'r', contentHash: 'a',
        provider: 'p', model: 'm', dimensions: 3, vector: vec([1, 0, 0]),
        textUsed: 'a', createdAt: now,
      },
      {
        id: 'B', label: 'Function', nodeId: 'b', repoUrl: 'r', contentHash: 'b',
        provider: 'p', model: 'm', dimensions: 3, vector: vec([0.9, 0.1, 0]),
        textUsed: 'b', createdAt: now,
      },
      {
        id: 'C', label: 'Function', nodeId: 'c', repoUrl: 'r', contentHash: 'c',
        provider: 'p', model: 'm', dimensions: 3, vector: vec([0, 1, 0]),
        textUsed: 'c', createdAt: now,
      },
    ]);

    const hits = repo.searchSimilar(asF32([1, 0, 0]), { k: 3 });
    expect(hits.map((h) => h.row.id)).toEqual(['A', 'B', 'C']);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it('searchSimilar filters by label and repo', () => {
    const now = new Date().toISOString();
    repo.upsert([
      {
        id: 'A', label: 'Function', nodeId: 'a', repoUrl: 'r1', contentHash: 'a',
        provider: 'p', model: 'm', dimensions: 2, vector: vec([1, 0]),
        textUsed: 'a', createdAt: now,
      },
      {
        id: 'B', label: 'Doc', nodeId: 'b', repoUrl: 'r1', contentHash: 'b',
        provider: 'p', model: 'm', dimensions: 2, vector: vec([1, 0]),
        textUsed: 'b', createdAt: now,
      },
      {
        id: 'C', label: 'Function', nodeId: 'c', repoUrl: 'r2', contentHash: 'c',
        provider: 'p', model: 'm', dimensions: 2, vector: vec([1, 0]),
        textUsed: 'c', createdAt: now,
      },
    ]);

    const onlyFn = repo.searchSimilar(asF32([1, 0]), { label: 'Function' });
    expect(onlyFn.map((h) => h.row.id).sort()).toEqual(['A', 'C']);

    const onlyR1 = repo.searchSimilar(asF32([1, 0]), { repoUrl: 'r1' });
    expect(onlyR1.map((h) => h.row.id).sort()).toEqual(['A', 'B']);

    const both = repo.searchSimilar(asF32([1, 0]), { label: 'Function', repoUrl: 'r1' });
    expect(both.map((h) => h.row.id)).toEqual(['A']);
  });

  it('deleteByRepo removes only matching rows', () => {
    const now = new Date().toISOString();
    repo.upsert([
      { id: 'A', label: 'Function', nodeId: 'a', repoUrl: 'r1', contentHash: 'a', provider: 'p', model: 'm', dimensions: 2, vector: vec([1, 0]), textUsed: 'a', createdAt: now },
      { id: 'B', label: 'Function', nodeId: 'b', repoUrl: 'r2', contentHash: 'b', provider: 'p', model: 'm', dimensions: 2, vector: vec([0, 1]), textUsed: 'b', createdAt: now },
    ]);
    expect(repo.deleteByRepo('r1')).toBe(1);
    expect(repo.countAll()).toBe(1);
    expect(repo.findByNodeId('b')).toBeDefined();
  });

  it('searchSimilar ignores rows with mismatched dimensions', () => {
    const now = new Date().toISOString();
    repo.upsert([
      { id: 'A', label: 'Function', nodeId: 'a', repoUrl: 'r', contentHash: 'a', provider: 'p', model: 'm', dimensions: 3, vector: vec([1, 0, 0]), textUsed: 'a', createdAt: now },
    ]);
    const hits = repo.searchSimilar(asF32([1, 0]), {});
    expect(hits).toHaveLength(0);
  });
});
