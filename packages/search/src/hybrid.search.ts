/**
 * HybridSearch — BM25 + vector + RRF fusion + optional reranker + 1-hop graph.
 *
 * Pipeline:
 *   1. BM25 (top BM25_K) and vector (top VEC_K) in parallel.
 *   2. Fuse via Reciprocal Rank Fusion (k = 60).
 *   3. (optional) Rerank top FUSED_K with reranker → top `k`.
 *   4. Attach up to 5 1-hop graph neighbours per result.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { EmbeddingProvider } from '@ekg/embeddings';
import type {
  EmbeddingsRepository,
  EmbeddingRow,
  SearchTextRepository,
  Bm25Hit,
} from '@ekg/storage';
import { reciprocalRankFusion, type NamedList } from './rrf.js';
import type { Reranker } from './reranker.interface.js';
import type { GraphExpander, NeighbourEdge } from './graph.expansion.js';

const BM25_K = 50;
const VEC_K = 50;
const FUSED_K = 50;
const NEIGHBOUR_CAP = 5;
const DEFAULT_K = 10;

export type SearchMode = 'hybrid' | 'bm25' | 'vector';

export interface HybridSearchOptions {
  readonly label?: string;
  readonly repoUrl?: string;
  readonly k?: number;
  readonly mode?: SearchMode;
}

export interface HybridResult {
  readonly id: string;            // fusion key (label + nodeId)
  readonly nodeId: string;
  readonly label: string;
  readonly repoUrl: string;
  readonly name: string;
  readonly path: string;
  readonly snippet: string;
  readonly score: number;         // final score after fusion (and rerank if used)
  readonly bm25Score?: number;
  readonly vectorScore?: number;
  readonly rerankScore?: number;
  readonly neighbours: readonly NeighbourEdge[];
  /** Phase 2 follow-up: parsed embedding metadata (breadcrumb, lineRange...). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface InternalCandidate {
  readonly id: string;
  readonly nodeId: string;
  readonly label: string;
  readonly repoUrl: string;
  readonly name: string;
  readonly path: string;
  snippet: string;
  bm25Score?: number;
  vectorScore?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HybridSearchDeps {
  readonly embeddingsRepo?: EmbeddingsRepository;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly searchText: SearchTextRepository;
  readonly reranker?: Reranker;
  readonly graphExpander?: GraphExpander;
}

export class HybridSearch {
  private readonly deps: HybridSearchDeps;
  private readonly logger: Logger;

  constructor(deps: HybridSearchDeps) {
    this.deps = deps;
    this.logger = createLogger({ service: 'hybrid-search' });
  }

  async search(query: string, opts: HybridSearchOptions = {}): Promise<readonly HybridResult[]> {
    const k = Math.max(1, Math.min(opts.k ?? DEFAULT_K, 50));
    const mode = opts.mode ?? 'hybrid';

    const [bm25Hits, vecHits] = await Promise.all([
      mode === 'vector' ? Promise.resolve<readonly Bm25Hit[]>([]) : this.runBm25(query, opts),
      mode === 'bm25' ? Promise.resolve<readonly { row: EmbeddingRow; score: number }[]>([]) : this.runVector(query, opts),
    ]);

    const candidates = this.collectCandidates(bm25Hits, vecHits);
    if (candidates.size === 0) return [];

    let rankedIds: readonly string[];
    if (mode === 'bm25') {
      rankedIds = bm25Hits.map((h) => idOf(h.label, h.nodeId));
    } else if (mode === 'vector') {
      rankedIds = vecHits.map((h) => idOf(h.row.label, h.row.nodeId));
    } else {
      rankedIds = this.fuse(bm25Hits, vecHits);
    }

    const top = rankedIds.slice(0, FUSED_K).map((id) => candidates.get(id)).filter(isDefined);
    const reranked = await this.maybeRerank(query, top);
    const finalSlice = reranked.slice(0, k);

    return await this.attachNeighbours(finalSlice);
  }

  private async runBm25(query: string, opts: HybridSearchOptions): Promise<readonly Bm25Hit[]> {
    try {
      return this.deps.searchText.searchBm25(query, {
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
        k: BM25_K,
      });
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'BM25 leg failed');
      return [];
    }
  }

  private async runVector(
    query: string,
    opts: HybridSearchOptions,
  ): Promise<readonly { row: EmbeddingRow; score: number }[]> {
    const repo = this.deps.embeddingsRepo;
    const provider = this.deps.embeddingProvider;
    if (!repo || !provider) return [];
    try {
      const [vec] = await provider.embed([query]);
      if (!vec || vec.length !== provider.dimensions) {
        this.logger.warn({ got: vec?.length ?? 0, expected: provider.dimensions }, 'Bad query vector');
        return [];
      }
      const queryVec = new Float32Array(vec);
      const hits = repo.searchSimilar(queryVec, {
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
        k: VEC_K,
      });
      return hits;
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'Vector leg failed');
      return [];
    }
  }

  private collectCandidates(
    bm25: readonly Bm25Hit[],
    vec: readonly { row: EmbeddingRow; score: number }[],
  ): Map<string, InternalCandidate> {
    const out = new Map<string, InternalCandidate>();
    for (const h of bm25) {
      const id = idOf(h.label, h.nodeId);
      const existing = out.get(id);
      if (existing) {
        existing.bm25Score = h.score;
      } else {
        out.set(id, {
          id,
          nodeId: h.nodeId,
          label: h.label,
          repoUrl: h.repoUrl,
          name: h.name,
          path: h.path,
          snippet: '',
          bm25Score: h.score,
        });
      }
    }
    for (const h of vec) {
      const id = idOf(h.row.label, h.row.nodeId);
      const existing = out.get(id);
      const snippet = h.row.textUsed.slice(0, 240);
      const meta = parseMetadata(h.row.metadata);
      if (existing) {
        existing.vectorScore = h.score;
        if (!existing.snippet) existing.snippet = snippet;
        if (meta && !existing.metadata) existing.metadata = meta;
      } else {
        out.set(id, {
          id,
          nodeId: h.row.nodeId,
          label: h.row.label,
          repoUrl: h.row.repoUrl,
          name: '',
          path: '',
          snippet,
          vectorScore: h.score,
          ...(meta ? { metadata: meta } : {}),
        });
      }
    }
    return out;
  }

  private fuse(
    bm25: readonly Bm25Hit[],
    vec: readonly { row: EmbeddingRow; score: number }[],
  ): readonly string[] {
    const lists: NamedList<{ id: string }>[] = [
      {
        source: 'bm25',
        items: bm25.map((h) => ({ id: idOf(h.label, h.nodeId) })),
        scores: new Map(bm25.map((h) => [idOf(h.label, h.nodeId), h.score])),
      },
      {
        source: 'vector',
        items: vec.map((h) => ({ id: idOf(h.row.label, h.row.nodeId) })),
        scores: new Map(vec.map((h) => [idOf(h.row.label, h.row.nodeId), h.score])),
      },
    ];
    return reciprocalRankFusion(lists).map((f) => f.id);
  }

  private async maybeRerank(query: string, top: readonly InternalCandidate[]): Promise<readonly HybridResult[]> {
    if (top.length === 0) return [];
    const reranker = this.deps.reranker;
    if (!reranker || reranker.id === 'noop') {
      return top.map((c, i) => toResult(c, top.length - i));
    }
    const docs = top.map((c) => buildDoc(c));
    const scores = await reranker.rerank(query, docs);
    const withScores = top.map((c, i) => ({ c, rerankScore: scores[i] ?? 0 }));
    withScores.sort((a, b) => b.rerankScore - a.rerankScore);
    return withScores.map(({ c, rerankScore }) => toResult(c, rerankScore, rerankScore));
  }

  private async attachNeighbours(results: readonly HybridResult[]): Promise<readonly HybridResult[]> {
    const expander = this.deps.graphExpander;
    if (!expander) return results;
    const out: HybridResult[] = [];
    for (const r of results) {
      const ns = await expander.expand(r.label, r.nodeId);
      out.push({ ...r, neighbours: ns.slice(0, NEIGHBOUR_CAP) });
    }
    return out;
  }
}

function toResult(c: InternalCandidate, score: number, rerankScore?: number): HybridResult {
  return {
    id: c.id,
    nodeId: c.nodeId,
    label: c.label,
    repoUrl: c.repoUrl,
    name: c.name,
    path: c.path,
    snippet: c.snippet,
    score,
    ...(c.bm25Score !== undefined ? { bm25Score: c.bm25Score } : {}),
    ...(c.vectorScore !== undefined ? { vectorScore: c.vectorScore } : {}),
    ...(rerankScore !== undefined ? { rerankScore } : {}),
    ...(c.metadata ? { metadata: c.metadata } : {}),
    neighbours: [],
  };
}

function parseMetadata(raw: string | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
  return undefined;
}

function buildDoc(c: InternalCandidate): string {
  const parts = [c.name, c.path, c.snippet].filter((s) => s && s.length > 0);
  const joined = parts.join('\n');
  return joined.slice(0, 4000);
}

function idOf(label: string, nodeId: string): string {
  return `${label}:${nodeId}`;
}

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
