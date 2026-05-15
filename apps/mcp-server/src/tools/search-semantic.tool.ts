/**
 * MCP Tool: search_semantic
 *
 * Vector search over embedded Function/Doc/Table/API nodes.
 * Refuses if EKG_EMBEDDINGS_ENABLED is not 'true'.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EmbeddingsService } from '@ekg/worker';

const labelSchema = z.enum(['Function', 'Doc', 'Table', 'API']);

export function registerSearchSemanticTool(
  server: McpServer,
  embeddings: EmbeddingsService | undefined,
): void {
  server.tool(
    'search_semantic',
    'Vector search over embedded Function, Doc, Table, and API nodes. Requires EKG_EMBEDDINGS_ENABLED=true and a configured embedding provider (Ollama by default).',
    {
      query: z.string().min(1).describe('Natural-language query'),
      label: labelSchema.optional().describe('Restrict to one node label'),
      repo: z.string().optional().describe('Restrict to a single repo URL'),
      k: z.number().int().min(1).max(50).default(10).describe('Number of results (1-50)'),
    },
    async ({ query, label, repo, k }) => {
      if (!embeddings || !embeddings.enabled) {
        return {
          content: [{
            type: 'text' as const,
            text: 'search_semantic is disabled. Set EKG_EMBEDDINGS_ENABLED=true and restart the MCP server.',
          }],
          isError: true,
        };
      }

      try {
        const repository = embeddings.getRepository();
        const provider = embeddings.getProvider();
        if (!repository || !provider) {
          return {
            content: [{ type: 'text' as const, text: 'Embeddings not initialised.' }],
            isError: true,
          };
        }

        const [vec] = await provider.embed([query]);
        if (!vec || vec.length !== provider.dimensions) {
          return {
            content: [{
              type: 'text' as const,
              text: `Provider returned an unexpected vector (got ${vec?.length ?? 0}, expected ${provider.dimensions}).`,
            }],
            isError: true,
          };
        }

        const queryVec = new Float32Array(vec);
        const hits = repository.searchSimilar(queryVec, {
          ...(label ? { label } : {}),
          ...(repo ? { repoUrl: repo } : {}),
          k,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query,
              provider: provider.id,
              model: provider.model,
              count: hits.length,
              hits: hits.map((h) => ({
                score: Number(h.score.toFixed(4)),
                id: h.row.id,
                nodeId: h.row.nodeId,
                label: h.row.label,
                repoUrl: h.row.repoUrl,
                snippet: h.row.textUsed.slice(0, 240),
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `search_semantic failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
