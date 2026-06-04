/**
 * MCP Tool: search_by_vector (Phase D)
 *
 * Native vector search over graph nodes — embeds the user query, then runs
 * Neo4j's native vector index for a label (Function, Doc, Table, API).
 *
 * Differs from `search_codebase` (which uses BM25 + SQLite vectors + RRF):
 *   - Bypasses the search-text index entirely
 *   - Returns whole node properties for graph follow-ups
 *   - Lets the agent answer "semantically similar functions" purely via graph
 *
 * Requires:
 *   - EKG_GRAPH_VECTORS=true at ingest time (vectors mirrored onto nodes)
 *   - An embeddings provider configured for the query embed
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';
import type { EmbeddingsService } from '@ekg/worker';

const VALID_LABELS = ['Function', 'Doc', 'Table', 'API'] as const;

export interface SearchByVectorDeps {
  readonly queries: GraphQueries;
  readonly embeddings?: EmbeddingsService;
}

export function registerSearchByVectorTool(server: McpServer, deps: SearchByVectorDeps): void {
  server.tool(
    'search_by_vector',
    'Phase D: semantic search over graph nodes via Neo4j native vector index. Embeds the query, finds the top-K most similar nodes for the given label (Function/Doc/Table/API), and returns them with their full graph properties. Requires ingestion with EKG_GRAPH_VECTORS=true.',
    {
      query: z.string().min(1).describe('Natural-language query to embed.'),
      label: z.enum(VALID_LABELS).default('Function').describe('Node label to search within.'),
      limit: z.number().int().positive().max(50).default(10),
    },
    async ({ query, label, limit }) => {
      if (!deps.embeddings) {
        return jsonResponse({ ok: false, reason: 'EmbeddingsService not wired on this server.' });
      }
      const provider = deps.embeddings.getProvider();
      if (!provider) {
        return jsonResponse({ ok: false, reason: 'No embeddings provider configured. Set EMBEDDINGS_PROVIDER env.' });
      }
      let queryVec: number[];
      try {
        const vectors = await provider.embed([query]);
        const v = vectors[0];
        if (!v || v.length === 0) {
          return jsonResponse({ ok: false, reason: 'Provider returned empty vector for query.' });
        }
        queryVec = Array.from(v);
      } catch (err) {
        return jsonResponse({ ok: false, reason: `Query embedding failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      try {
        const hits = await deps.queries.searchNodesByVector(label, queryVec, limit);
        return jsonResponse({
          ok: true,
          label,
          query,
          count: hits.length,
          hits: hits.map((h) => ({
            id: h.id,
            name: h.name,
            score: Number(h.score.toFixed(4)),
            // Trim large properties from the response — agents usually only need a teaser.
            properties: trimProps(h.properties),
          })),
        });
      } catch (err) {
        return jsonResponse({ ok: false, reason: `Vector search failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

const HEAVY_PROPS = new Set(['embedding', 'rawText', 'body']);
const TRIM_LIMIT = 400;
function trimProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (HEAVY_PROPS.has(k)) continue;
    if (typeof v === 'string' && v.length > TRIM_LIMIT) {
      out[k] = `${v.slice(0, TRIM_LIMIT)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
