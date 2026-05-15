/**
 * MCP Resource: ekg://graph-stats
 *
 * Provides graph statistics — node/edge counts and last ingestion time.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Neo4jClient } from '@ekg/graph';
import { GraphRepository } from '@ekg/graph';
import type { SqliteRepository } from '@ekg/storage';

export function registerGraphStatsResource(
  server: McpServer,
  neo4jClient: Neo4jClient,
  sqliteRepo: SqliteRepository,
): void {
  const graphRepo = new GraphRepository(neo4jClient);

  server.resource(
    'graph-stats',
    'ekg://graph-stats',
    {
      description: 'Knowledge graph statistics — total nodes, edges, and ingestion status',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const stats = await graphRepo.getStats();

        return {
          contents: [{
            uri: 'ekg://graph-stats',
            mimeType: 'application/json',
            text: JSON.stringify({
              graph: {
                totalNodes: stats.nodes,
                totalEdges: stats.edges,
              },
              status: 'connected',
            }, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ekg://graph-stats',
            mimeType: 'application/json',
            text: JSON.stringify({
              graph: { totalNodes: 0, totalEdges: 0 },
              status: 'disconnected',
            }, null, 2),
          }],
        };
      }
    },
  );
}
