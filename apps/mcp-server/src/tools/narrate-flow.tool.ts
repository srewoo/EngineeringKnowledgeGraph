/**
 * MCP Tool: narrate_flow
 *
 * Synthesizes a flow (same inputs as `synthesize_flow`) and converts it into
 * prose with citations. Falls back to a deterministic plain-English template
 * when `EKG_AGENT_ENABLED !== 'true'` — never refuses for lack of LLM.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';
import {
  Neo4jFlowExecutor,
  synthesizeFlow,
  FlowNarrator,
  FLOW_DEFAULT_HOPS,
  FLOW_MAX_HOPS,
  type NarrationAgent,
} from '@ekg/advanced';

export interface NarrateFlowDeps {
  readonly neo4j: Neo4jClient;
  /** Optional agent — when null/omitted, falls back to deterministic mode. */
  readonly agent?: NarrationAgent | null;
}

export function registerNarrateFlowTool(server: McpServer, deps: NarrateFlowDeps): void {
  const llmEnabled = (process.env['EKG_AGENT_ENABLED'] ?? 'false').toLowerCase() === 'true';
  const agent = llmEnabled ? deps.agent ?? null : null;

  server.tool(
    'narrate_flow',
    'Walk a flow from a seed (route/api/service) and produce a narrative with citations. Deterministic skeleton by default; polished by the LLM agent when EKG_AGENT_ENABLED=true.',
    {
      seed: z.object({
        kind: z.enum(['route', 'api', 'service']),
        value: z.string().min(1),
      }),
      maxHops: z.number().int().min(1).max(FLOW_MAX_HOPS).default(FLOW_DEFAULT_HOPS),
      includeKafka: z.boolean().default(true),
      audience: z.enum(['engineer', 'pm']).default('engineer'),
      maxBullets: z.number().int().min(1).max(50).default(6),
    },
    async ({ seed, maxHops, includeKafka, audience, maxBullets }) => {
      try {
        const exec = new Neo4jFlowExecutor(deps.neo4j);
        const flow = await synthesizeFlow(exec, seed, { maxHops, includeKafka });
        const narrator = new FlowNarrator(agent);
        const narration = await narrator.narrate(flow, { audience, maxBullets });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              seed,
              mode: narration.mode,
              text: narration.text,
              citations: narration.citations,
              ...(narration.usage ? { usage: narration.usage } : {}),
              summary: { nodes: flow.nodes.length, edges: flow.edges.length, paths: flow.paths.length, truncated: flow.truncated },
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `narrate_flow failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
