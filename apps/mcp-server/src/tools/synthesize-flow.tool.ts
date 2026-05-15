/**
 * MCP Tool: synthesize_flow
 *
 * Walks the graph from a seed (route / API / service) outward across HTTP,
 * Kafka and DB boundaries to produce a deterministic FlowGraph plus an
 * optional Mermaid sequence diagram.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';
import {
  Neo4jFlowExecutor,
  synthesizeFlow,
  renderSequenceDiagram,
  FLOW_DEFAULT_HOPS,
  FLOW_MAX_HOPS,
} from '@ekg/advanced';

export function registerSynthesizeFlowTool(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'synthesize_flow',
    'Synthesize an end-to-end flow from a seed (frontend route, API endpoint, or service entry) across HTTP calls, Kafka topics and DB writes. Deterministic graph walk; no LLM.',
    {
      seed: z.object({
        kind: z.enum(['route', 'api', 'service']),
        value: z.string().min(1),
      }),
      maxHops: z.number().int().min(1).max(FLOW_MAX_HOPS).default(FLOW_DEFAULT_HOPS),
      includeKafka: z.boolean().default(true),
      format: z.enum(['json', 'mermaid']).default('mermaid'),
    },
    async ({ seed, maxHops, includeKafka, format }) => {
      try {
        const exec = new Neo4jFlowExecutor(neo4j);
        const flow = await synthesizeFlow(exec, seed, { maxHops, includeKafka });
        const mermaid = format === 'mermaid' || format === 'json'
          ? renderSequenceDiagram(flow, { title: `${seed.kind}:${seed.value}` })
          : undefined;
        const body = format === 'mermaid'
          ? { seed, mermaid, summary: { nodes: flow.nodes.length, edges: flow.edges.length, paths: flow.paths.length, truncated: flow.truncated } }
          : { flow, mermaid };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `synthesize_flow failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
