import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../../src/hybrid.search.js';
import type { Bm25Hit, EmbeddingRow, SimilarityHit } from '@ekg/storage';
import type { GraphExpander, NeighbourEdge } from '../../src/graph.expansion.js';
import type { Reranker } from '../../src/reranker.interface.js';

function bm25(label: string, nodeId: string, score: number, name = ''): Bm25Hit {
  return { label, nodeId, repoUrl: 'r', score, name, path: '' };
}

function vec(label: string, nodeId: string, score: number, text = ''): SimilarityHit {
  const row: EmbeddingRow = {
    id: `${label}:${nodeId}`,
    label,
    nodeId,
    repoUrl: 'r',
    contentHash: 'h',
    provider: 'p',
    model: 'm',
    dimensions: 1,
    vector: Buffer.from(new Float32Array([1]).buffer),
    textUsed: text,
    createdAt: new Date().toISOString(),
  };
  return { row, score };
}

function makeSearchText(hits: readonly Bm25Hit[]) {
  return {
    searchBm25: vi.fn(() => hits),
    deleteByRepo: vi.fn(() => 0),
    index: vi.fn(),
    countAll: vi.fn(() => hits.length),
    close: vi.fn(),
  } as unknown as Parameters<typeof HybridSearch>[0]['searchText'] extends never ? never : import('@ekg/storage').SearchTextRepository;
}

function makeEmbeddings(hits: readonly SimilarityHit[]) {
  return {
    searchSimilar: vi.fn(() => hits),
  } as unknown as import('@ekg/storage').EmbeddingsRepository;
}

const fakeProvider = {
  id: 'noop' as const,
  model: 'fake',
  dimensions: 1,
  embed: async (texts: readonly string[]) => texts.map(() => [1]),
};

class StaticExpander implements GraphExpander {
  constructor(private readonly map: ReadonlyMap<string, readonly NeighbourEdge[]>) {}
  async expand(label: string, nodeId: string): Promise<readonly NeighbourEdge[]> {
    return this.map.get(`${label}:${nodeId}`) ?? [];
  }
}

class FixedReranker implements Reranker {
  readonly id = 'cohere' as const;
  constructor(private readonly scoreById: ReadonlyMap<string, number>) {}
  async rerank(_query: string, docs: readonly string[]): Promise<readonly number[]> {
    return docs.map((d) => {
      for (const [id, s] of this.scoreById) {
        if (d.includes(id)) return s;
      }
      return 0;
    });
  }
}

describe('HybridSearch', () => {
  it('fuses bm25 and vector results, prefers items appearing in both', async () => {
    const bm = [bm25('Function', 'a', 5, 'a'), bm25('Function', 'b', 4, 'b'), bm25('Function', 'c', 3, 'c')];
    const vc = [vec('Function', 'b', 0.9, 'b body'), vec('Function', 'd', 0.8), vec('Function', 'a', 0.7, 'a body')];
    const search = new HybridSearch({
      searchText: makeSearchText(bm),
      embeddingsRepo: makeEmbeddings(vc),
      embeddingProvider: fakeProvider,
    });
    const results = await search.search('q', { k: 4 });
    const ids = results.map((r) => r.nodeId);
    expect(ids[0]).toBe('b');
    expect(ids).toContain('a');
    const a = results.find((r) => r.nodeId === 'a')!;
    expect(a.bm25Score).toBe(5);
    expect(a.vectorScore).toBe(0.7);
  });

  it('attaches neighbours from the graph expander', async () => {
    const bm = [bm25('Function', 'a', 5)];
    const expander = new StaticExpander(new Map([
      ['Function:a', [{ id: 'x', label: 'File', name: 'x.ts', edge: 'DEFINES', direction: 'in' as const }]],
    ]));
    const search = new HybridSearch({ searchText: makeSearchText(bm), graphExpander: expander });
    const results = await search.search('q', { mode: 'bm25', k: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.neighbours).toHaveLength(1);
    expect(results[0]!.neighbours[0]!.edge).toBe('DEFINES');
  });

  it('reranker reorders results', async () => {
    const bm = [bm25('Function', 'a', 5, 'a'), bm25('Function', 'b', 4, 'b')];
    const reranker = new FixedReranker(new Map([['a', 0.1], ['b', 0.9]]));
    const search = new HybridSearch({
      searchText: makeSearchText(bm),
      reranker,
    });
    const results = await search.search('q', { mode: 'bm25', k: 2 });
    expect(results.map((r) => r.nodeId)).toEqual(['b', 'a']);
    expect(results[0]!.rerankScore).toBe(0.9);
  });

  it('returns empty when no candidates match', async () => {
    const search = new HybridSearch({ searchText: makeSearchText([]) });
    const results = await search.search('q', { mode: 'bm25' });
    expect(results).toEqual([]);
  });

  it('mode=bm25 skips the vector leg', async () => {
    const embeddingsRepo = { searchSimilar: vi.fn() } as unknown as import('@ekg/storage').EmbeddingsRepository;
    const provider = { ...fakeProvider, embed: vi.fn(async () => [[1]]) };
    const search = new HybridSearch({
      searchText: makeSearchText([bm25('Function', 'a', 5)]),
      embeddingsRepo,
      embeddingProvider: provider,
    });
    await search.search('q', { mode: 'bm25' });
    expect(provider.embed).not.toHaveBeenCalled();
    expect((embeddingsRepo as unknown as { searchSimilar: ReturnType<typeof vi.fn> }).searchSimilar).not.toHaveBeenCalled();
  });
});
