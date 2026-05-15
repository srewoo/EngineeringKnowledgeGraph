import { describe, it, expect } from 'vitest';
import { chunkRows, MAX_UNWIND_CHUNK_SIZE } from '../../src/graph.repository.js';

describe('chunkRows', () => {
  it('returns empty array for empty input', () => {
    expect(chunkRows([], 10)).toEqual([]);
  });

  it('splits exactly at boundaries', () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);
    expect(chunkRows(rows, 5)).toEqual([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]);
  });

  it('handles single-element input', () => {
    expect(chunkRows([42], 5)).toEqual([[42]]);
  });

  it('handles size + 1 — last chunk has one element', () => {
    const rows = Array.from({ length: 6 }, (_, i) => i);
    expect(chunkRows(rows, 5)).toEqual([[0, 1, 2, 3, 4], [5]]);
  });

  it('returns one chunk when size > rows.length', () => {
    expect(chunkRows([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });

  it('respects MAX_UNWIND_CHUNK_SIZE constant of 5_000', () => {
    expect(MAX_UNWIND_CHUNK_SIZE).toBe(5_000);
    const rows = Array.from({ length: 12_345 }, (_, i) => i);
    const chunks = chunkRows(rows, MAX_UNWIND_CHUNK_SIZE);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(5_000);
    expect(chunks[1]?.length).toBe(5_000);
    expect(chunks[2]?.length).toBe(2_345);
  });

  it('throws on size <= 0 — silent fallback would mean one giant chunk', () => {
    expect(() => chunkRows([1, 2], 0)).toThrow();
    expect(() => chunkRows([1, 2], -1)).toThrow();
  });
});
