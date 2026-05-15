/**
 * MCP Tool: list_databases
 *
 * Enumerate all databases discovered in the knowledge graph.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerListDatabasesTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'list_databases',
    'List all databases discovered in the engineering knowledge graph. Returns database names, types (Couchbase, MongoDB, Redis, etc.), and how they were detected.',
    {},
    async () => {
      try {
        const databases = await queries.listDatabases();

        if (databases.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No databases found in the knowledge graph. Run ingest_repo first.',
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: databases.length,
              databases: databases.map((d) => ({
                name: d.name,
                ...d.properties,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Query failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
