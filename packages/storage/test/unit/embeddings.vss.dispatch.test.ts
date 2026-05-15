import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingsRepository, type EmbeddingRow } from '../../src/embeddings.repository.js';
import { readVectorIndexMode } from '../../src/embeddings.vss.js';

function vec(values: readonly number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function asF32(values: readonly number[]): Float32Array {
  return new Float32Array(values);
}

function row(over: Partial<EmbeddingRow> = {}): EmbeddingRow {
  return {
    id: 'A',
    label: 'Function',
    nodeId: 'fn:a',
    repoUrl: 'r1',
    contentHash: 'h',
    provider: 'p',
    model: 'm',
    dimensions: 3,
    vector: vec([1, 0, 0]),
    textUsed: 't',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('EKG_VECTOR_INDEX dispatch', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-vss-disp-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('readVectorIndexMode defaults to brute', () => {
    expect(readVectorIndexMode({})).toBe('brute');
    expect(readVectorIndexMode({ EKG_VECTOR_INDEX: 'brute' })).toBe('brute');
    expect(readVectorIndexMode({ EKG_VECTOR_INDEX: 'BRUTE' })).toBe('brute');
    expect(readVectorIndexMode({ EKG_VECTOR_INDEX: 'something-else' })).toBe('brute');
  });

  it('readVectorIndexMode accepts vss', () => {
    expect(readVectorIndexMode({ EKG_VECTOR_INDEX: 'vss' })).toBe('vss');
    expect(readVectorIndexMode({ EKG_VECTOR_INDEX: 'VSS' })).toBe('vss');
  });

  it('brute mode searches successfully without sqlite-vss', () => {
    const repo = new EmbeddingsRepository(join(tempDir, 'b.db'), { vectorMode: 'brute' });
    repo.upsert([row({ id: 'A', nodeId: 'a', vector: vec([1, 0, 0]) })]);
    const hits = repo.searchSimilar(asF32([1, 0, 0]));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.row.nodeId).toBe('a');
    repo.close();
  });

  it('vss mode falls back to brute when sqlite-vss native module unavailable', () => {
    // sqlite-vss is an optionalDependency; in CI/dev where the wheel isn't
    // installed, the adapter logs a warn and returns unavailable. The repo
    // must still produce correct brute-force results — this is the contract.
    const repo = new EmbeddingsRepository(join(tempDir, 'v.db'), { vectorMode: 'vss' });
    repo.upsert([
      row({ id: 'A', nodeId: 'a', vector: vec([1, 0, 0]) }),
      row({ id: 'B', nodeId: 'b', vector: vec([0, 1, 0]), contentHash: 'h2' }),
    ]);
    const hits = repo.searchSimilar(asF32([1, 0, 0]), { k: 2 });
    // Either: (a) sqlite-vss installed and ranks 'a' first via ANN, or
    //         (b) absent → brute-force ranks 'a' first via cosine.
    // Both must return 'a' as the top hit.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.row.nodeId).toBe('a');
    repo.close();
  });
});
