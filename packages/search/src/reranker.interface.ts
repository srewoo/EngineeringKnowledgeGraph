/**
 * Reranker — takes (query, docs) and returns a relevance score per doc.
 * Higher score = more relevant. Implementations may call hosted APIs
 * (Cohere, Voyage) or run a no-op identity ranker for local dev.
 */

export type RerankerId = 'cohere' | 'voyage' | 'noop';

export interface Reranker {
  readonly id: RerankerId;
  rerank(query: string, docs: readonly string[]): Promise<readonly number[]>;
}
