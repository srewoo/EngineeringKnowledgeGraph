/**
 * MCP Tool: get_metrics
 *
 * Returns in-process EKG metrics snapshot. Useful for agents that want a
 * single tool call instead of polling the ekg://metrics resource.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { metrics } from '@ekg/shared';
import { Neo4jClient, GraphRepository } from '@ekg/graph';

export function registerGetMetricsTool(server: McpServer, neo4jClient: Neo4jClient): void {
  const graphRepo = new GraphRepository(neo4jClient);

  server.tool(
    'get_metrics',
    'Return EKG runtime metrics — ingest counters (success/failed/files_processed), parse durations, graph size (nodes/edges), and query histograms.',
    {
      includeGraph: z.boolean().default(true).describe('Include live graph node/edge counts (one Neo4j query)'),
    },
    async ({ includeGraph }) => {
      const snap = metrics.snapshot();
      let graph: { nodes: number; edges: number; status: string } = { nodes: 0, edges: 0, status: 'skipped' };
      if (includeGraph) {
        try {
          const s = await graphRepo.getStats();
          graph = { nodes: s.nodes, edges: s.edges, status: 'connected' };
        } catch {
          graph = { nodes: 0, edges: 0, status: 'disconnected' };
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            uptimeMs: snap.uptimeMs,
            graph,
            counters: snap.counters,
            gauges: snap.gauges,
            histograms: snap.histograms,
          }, null, 2),
        }],
      };
    },
  );
}
