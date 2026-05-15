/**
 * retrieve.semantic — wraps HybridSearch (BM25 + vector + RRF + rerank +
 * 1-hop graph). Default mode is hybrid; the agent can override per call.
 */

import { z } from 'zod';
import type { HybridSearch } from '@ekg/search';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

const MAX_K = 25;
const RESULT_TEXT_CAP = 8000;

const inputSchema = z.object({
  query: z.string().min(1).max(2000),
  label: z.string().optional(),
  repoUrl: z.string().optional(),
  k: z.number().int().min(1).max(MAX_K).optional(),
  mode: z.enum(['hybrid', 'bm25', 'vector']).optional(),
});
type Input = z.infer<typeof inputSchema>;

export function buildSemanticRetrieveTool(hybrid: HybridSearch): AgentTool<Input> {
  return {
    name: 'retrieve.semantic',
    description:
      'Hybrid semantic + lexical retrieval over the EKG graph (BM25 + vector + reranker + 1-hop neighbours). ' +
      'Default mode is hybrid. Returns ranked nodes with name, path, snippet, and graph neighbours.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query.' },
        label: { type: 'string', description: 'Restrict to a node label (e.g. Function, Table, API, Doc).' },
        repoUrl: { type: 'string', description: 'Restrict to a single repo URL.' },
        k: { type: 'integer', description: `Top-K results (1-${MAX_K})`, minimum: 1, maximum: MAX_K },
        mode: { type: 'string', enum: ['hybrid', 'bm25', 'vector'] },
      },
      required: ['query'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const k = Math.min(Math.max(input.k ?? 10, 1), MAX_K);
      const out = await hybrid.search(input.query, {
        ...(input.label ? { label: input.label } : {}),
        ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        k,
      });
      const summary = out.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        label: r.label,
        name: r.name,
        path: r.path,
        repoUrl: r.repoUrl,
        score: r.score,
        snippet: truncate(r.snippet ?? '', 400),
      }));
      const seenIds = out.flatMap((r) => [r.id, `${r.label}:${r.nodeId}`, r.path].filter(Boolean));
      return {
        text: truncate(JSON.stringify({ results: summary, count: summary.length }, null, 2), RESULT_TEXT_CAP),
        seenIds,
        raw: { results: summary },
      };
    },
  };
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}
