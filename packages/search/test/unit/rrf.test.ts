import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K, type NamedList } from '../../src/rrf.js';

interface Item {
  readonly id: string;
}

describe('reciprocalRankFusion', () => {
  it('returns empty array when given empty lists', () => {
    const result = reciprocalRankFusion<Item>([]);
    expect(result).toEqual([]);
  });

  it('returns single-source ranking unchanged in order', () => {
    const list: NamedList<Item> = {
      source: 'bm25',
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };
    const result = reciprocalRankFusion([list]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(result[0]!.score).toBeCloseTo(1 / (RRF_K + 1));
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it('boosts items appearing in both lists above singletons', () => {
    const bm25: NamedList<Item> = {
      source: 'bm25',
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };
    const vec: NamedList<Item> = {
      source: 'vector',
      items: [{ id: 'b' }, { id: 'd' }, { id: 'a' }],
    };
    const result = reciprocalRankFusion([bm25, vec]);
    const ids = result.map((r) => r.id);
    // 'b' is rank 2 + rank 1 → strongest. 'a' is rank 1 + rank 3 → also strong.
    expect(ids[0]).toBe('b');
    expect(ids.includes('a')).toBe(true);
    const aResult = result.find((r) => r.id === 'a')!;
    const cResult = result.find((r) => r.id === 'c')!;
    expect(aResult.score).toBeGreaterThan(cResult.score);
  });

  it('records all source contributions for an item', () => {
    const lists: readonly NamedList<Item>[] = [
      { source: 'bm25', items: [{ id: 'x' }], scores: new Map([['x', 0.9]]) },
      { source: 'vector', items: [{ id: 'x' }], scores: new Map([['x', 0.7]]) },
    ];
    const result = reciprocalRankFusion(lists);
    expect(result).toHaveLength(1);
    expect(result[0]!.sources).toHaveLength(2);
    expect(result[0]!.sources.map((s) => s.source).sort()).toEqual(['bm25', 'vector']);
  });

  it('breaks ties by insertion order (stable)', () => {
    const list: NamedList<Item> = {
      source: 'bm25',
      items: [{ id: 'a' }, { id: 'b' }],
    };
    const result = reciprocalRankFusion([list]);
    expect(result[0]!.id).toBe('a');
  });

  it('rejects non-positive k', () => {
    expect(() => reciprocalRankFusion<Item>([], 0)).toThrow();
    expect(() => reciprocalRankFusion<Item>([], -1)).toThrow();
  });
});
