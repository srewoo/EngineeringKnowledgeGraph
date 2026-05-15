import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingsRepository, type EmbeddingRow } from '../../src/embeddings.repository.js';

function vec(values: readonly number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function row(over: Partial<EmbeddingRow> = {}): EmbeddingRow {
  return {
    id: 'Function:fn:1',
    label: 'Function',
    nodeId: 'fn:1',
    repoUrl: 'r1',
    contentHash: 'h',
    provider: 'p',
    model: 'm',
    dimensions: 2,
    vector: vec([1, 0]),
    textUsed: 't',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('EmbeddingsRepository — deletion', () => {
  let tempDir: string;
  let repo: EmbeddingsRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-emb-del-'));
    repo = new EmbeddingsRepository(join(tempDir, 'emb.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('deleteByNodeIds removes only matching rows', () => {
    repo.upsert([
      row({ id: 'A', nodeId: 'fn:a' }),
      row({ id: 'B', nodeId: 'fn:b' }),
      row({ id: 'C', nodeId: 'fn:c' }),
    ]);
    const removed = repo.deleteByNodeIds(['fn:a', 'fn:c']);
    expect(removed).toBe(2);
    expect(repo.countAll()).toBe(1);
    expect(repo.findByNodeId('fn:b')).toBeDefined();
    expect(repo.findByNodeId('fn:a')).toBeUndefined();
  });

  it('deleteByNodeIds is a no-op for empty input', () => {
    repo.upsert([row()]);
    expect(repo.deleteByNodeIds([])).toBe(0);
    expect(repo.countAll()).toBe(1);
  });

  it('deleteByNodeIds chunks at 500 (handles >500 ids)', () => {
    const rows: EmbeddingRow[] = [];
    for (let i = 0; i < 1200; i++) {
      rows.push(row({ id: `id-${i}`, nodeId: `n:${i}`, contentHash: `h-${i}` }));
    }
    repo.upsert(rows);
    expect(repo.countAll()).toBe(1200);
    const ids = rows.map((r) => r.nodeId);
    const removed = repo.deleteByNodeIds(ids);
    expect(removed).toBe(1200);
    expect(repo.countAll()).toBe(0);
  });

  it('listNodeIdsByRepo returns distinct ids for the given repo', () => {
    repo.upsert([
      row({ id: 'A', nodeId: 'fn:a', repoUrl: 'r1' }),
      row({ id: 'A2', nodeId: 'fn:a', repoUrl: 'r1', contentHash: 'h2' }), // same node_id, dedup
      row({ id: 'B', nodeId: 'fn:b', repoUrl: 'r1' }),
      row({ id: 'C', nodeId: 'fn:c', repoUrl: 'r2' }),
    ]);
    const ids = repo.listNodeIdsByRepo('r1').sort();
    expect(ids).toEqual(['fn:a', 'fn:b']);
  });

  it('roundtrips metadata column', () => {
    repo.upsert([row({ id: 'A', nodeId: 'fn:a', metadata: JSON.stringify({ breadcrumb: '[X > Y]' }) })]);
    const found = repo.findByNodeId('fn:a');
    expect(found?.metadata).toBe(JSON.stringify({ breadcrumb: '[X > Y]' }));
  });
});
