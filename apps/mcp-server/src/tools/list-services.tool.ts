/**
 * MCP Tool: list_services
 *
 * Enumerate all services discovered in the knowledge graph.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerListServicesTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'list_services',
    'List all services discovered in the engineering knowledge graph. Returns service names, detection methods, and associated repositories.',
    {},
    async () => {
      try {
        const services = await queries.listServices();

        if (services.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No services found in the knowledge graph. Run ingest_repo first.',
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: services.length,
              services: services.map((s) => ({
                name: s.name,
                ...s.properties,
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
