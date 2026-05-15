/**
 * MCP Tool: analyze_impact_v2
 *
 * Structured change-impact analysis keyed by (label, id). Distinct from the
 * Phase 1 `analyze_impact` tool which traverses by node-name. This one
 * uses per-label edge patterns and aggregates by service / repo.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';
import { Neo4jImpactExecutor, analyzeImpact } from '@ekg/advanced';

export function registerAnalyzeImpactV2Tool(server: McpServer, neo4j: Neo4jClient): void {
  server.tool(
    'analyze_impact_v2',
    'Code-change impact analysis by (label, id). Returns direct + transitive impacted nodes plus per-service / per-repo aggregates. Capped depth 4, per-layer cap 200.',
    {
      target: z.object({
        label: z.enum(['Column', 'Function', 'Table', 'API']),
        id: z.string().min(1),
      }),
    },
    async ({ target }) => {
      try {
        const exec = new Neo4jImpactExecutor(neo4j);
        const report = await analyzeImpact(exec, target);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `analyze_impact_v2 failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
