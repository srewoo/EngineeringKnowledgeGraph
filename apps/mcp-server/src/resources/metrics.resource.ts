/**
 * MCP Resource: ekg://metrics
 *
 * In-process metrics snapshot — counters, gauges, histograms.
 * Polled by dashboards or other agents that want to track ingest health.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { metrics } from '@ekg/shared';
import { Neo4jClient, GraphRepository } from '@ekg/graph';

export function registerMetricsResource(
  server: McpServer,
  neo4jClient: Neo4jClient,
): void {
  const graphRepo = new GraphRepository(neo4jClient);

  server.resource(
    'metrics',
    'ekg://metrics',
    {
      description: 'EKG runtime metrics — ingest counters, parse durations, graph size, query histograms',
      mimeType: 'application/json',
    },
    async () => {
      const snap = metrics.snapshot();
      let graphStats: { nodes: number; edges: number; status: string } = { nodes: 0, edges: 0, status: 'disconnected' };
      try {
        const s = await graphRepo.getStats();
        graphStats = { nodes: s.nodes, edges: s.edges, status: 'connected' };
      } catch { /* ignore */ }

      return {
        contents: [{
          uri: 'ekg://metrics',
          mimeType: 'application/json',
          text: JSON.stringify({
            uptimeMs: snap.uptimeMs,
            graph: graphStats,
            counters: snap.counters,
            gauges: snap.gauges,
            histograms: snap.histograms,
          }, null, 2),
        }],
      };
    },
  );
}
