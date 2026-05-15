/**
 * MCP Tool: get_api_map
 *
 * List all API endpoints, optionally filtered by service.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerGetApiMapTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'get_api_map',
    'List all API endpoints in the knowledge graph. Optionally filter by service name to see only the APIs a specific service exposes.',
    {
      service: z.string().optional().describe('Filter APIs by service name (optional)'),
    },
    async ({ service }) => {
      try {
        const apis = await queries.getApiMap(service);

        if (apis.length === 0) {
          const context = service ? ` for service "${service}"` : '';
          return {
            content: [{
              type: 'text' as const,
              text: `No API endpoints found${context}. Ensure repos with route definitions have been ingested.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              service: service ?? 'all',
              count: apis.length,
              endpoints: apis.map((a) => ({
                name: a.name,
                ...a.properties,
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
