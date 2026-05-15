/**
 * MCP Tool: search_codebase (Phase 2.2 — hybrid)
 *
 * Hybrid retrieval: BM25 + vector + RRF fusion + (optional) reranker
 * + 1-hop graph neighbour expansion.
 *
 * Modes:
 *   - hybrid (default): BM25 + vector + fusion. Falls back to BM25 only if
 *     embeddings are disabled.
 *   - bm25:   BM25 only. Always available; no embeddings needed.
 *   - vector: vector only. Requires EKG_EMBEDDINGS_ENABLED=true.
 *
 * Refuses non-bm25 modes if embeddings are disabled.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HybridSearch, Neo4jGraphExpander, getReranker, type HybridResult, type SearchMode } from '@ekg/search';
import type { SearchTextRepository } from '@ekg/storage';
import type { EmbeddingsService } from '@ekg/worker';
import type { Neo4jClient } from '@ekg/graph';

const labelSchema = z.enum(['Function', 'Doc', 'Table', 'API']);
const modeSchema = z.enum(['hybrid', 'bm25', 'vector']);

export interface SearchCodebaseDeps {
  readonly searchText: SearchTextRepository;
  readonly embeddingsService?: EmbeddingsService;
  readonly neo4jClient: Neo4jClient;
}

export function registerSearchCodebaseTool(
  server: McpServer,
  deps: SearchCodebaseDeps,
): void {
  server.tool(
    'search_codebase',
    'Hybrid search over Function/Doc/Table/API nodes. Combines BM25 (always available) with vector search (when EKG_EMBEDDINGS_ENABLED=true), fuses via RRF, optionally reranks (EKG_RERANKER=cohere|voyage), and expands each hit with up to 5 graph neighbours.',
    {
      query: z.string().min(1).describe('Natural-language query'),
      label: labelSchema.optional().describe('Restrict to one node label'),
      repo: z.string().optional().describe('Restrict to a single repo URL'),
      k: z.number().int().min(1).max(50).default(10).describe('Number of results (1-50)'),
      mode: modeSchema.optional().describe('hybrid | bm25 | vector (default: hybrid)'),
    },
    async ({ query, label, repo, k, mode }) => {
      const resolvedMode: SearchMode = mode ?? 'hybrid';
      const embEnabled = !!deps.embeddingsService?.enabled;

      if (resolvedMode === 'vector' && !embEnabled) {
        return {
          content: [{
            type: 'text' as const,
            text: 'mode=vector requires EKG_EMBEDDINGS_ENABLED=true. Use mode=bm25 or mode=hybrid (auto-falls-back to BM25).',
          }],
          isError: true,
        };
      }

      try {
        const expander = new Neo4jGraphExpander(deps.neo4jClient);
        let reranker;
        try {
          reranker = getReranker();
        } catch {
          reranker = undefined;
        }

        const hybrid = new HybridSearch({
          searchText: deps.searchText,
          ...(embEnabled && deps.embeddingsService
            ? {
                embeddingsRepo: deps.embeddingsService.getRepository(),
                embeddingProvider: deps.embeddingsService.getProvider(),
              }
            : {}),
          ...(reranker ? { reranker } : {}),
          graphExpander: expander,
        });

        const effectiveMode: SearchMode = resolvedMode === 'hybrid' && !embEnabled ? 'bm25' : resolvedMode;
        const results = await hybrid.search(query, {
          ...(label ? { label } : {}),
          ...(repo ? { repoUrl: repo } : {}),
          k,
          mode: effectiveMode,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query,
              mode: effectiveMode,
              ranking_explanation: explain(effectiveMode, !!reranker && reranker.id !== 'noop', embEnabled),
              count: results.length,
              results: results.map(serialiseResult),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `search_codebase failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

function serialiseResult(r: HybridResult) {
  return {
    score: Number(r.score.toFixed(4)),
    label: r.label,
    nodeId: r.nodeId,
    name: r.name,
    path: r.path,
    repoUrl: r.repoUrl,
    snippet: r.snippet,
    bm25Score: r.bm25Score !== undefined ? Number(r.bm25Score.toFixed(4)) : undefined,
    vectorScore: r.vectorScore !== undefined ? Number(r.vectorScore.toFixed(4)) : undefined,
    rerankScore: r.rerankScore !== undefined ? Number(r.rerankScore.toFixed(4)) : undefined,
    neighbours: r.neighbours.map((n) => ({
      label: n.label,
      id: n.id,
      name: n.name,
      edge: n.edge,
      direction: n.direction,
    })),
  };
}

function explain(mode: SearchMode, rerankerActive: boolean, embEnabled: boolean): string {
  const parts: string[] = [];
  if (mode === 'hybrid') parts.push('BM25 (top-50) + vector (top-50) fused via Reciprocal Rank Fusion (k=60)');
  else if (mode === 'bm25') parts.push('BM25 only (FTS5, porter+unicode61)');
  else parts.push('Vector only (cosine similarity over embedded text)');
  if (rerankerActive) parts.push('reranked by external reranker');
  parts.push('1-hop graph neighbours attached');
  if (mode !== 'bm25' && !embEnabled) parts.push('(NOTE: embeddings disabled — vector leg empty)');
  return parts.join(' → ');
}
