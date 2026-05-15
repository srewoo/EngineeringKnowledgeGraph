/**
 * MCP Tool: get_service_summary
 *
 * Get a complete overview of a service — APIs, databases, dependencies.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerGetServiceSummaryTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'get_service_summary',
    'Get a complete summary of a service: what APIs it exposes, what databases it uses, what services it depends on, and what services depend on it.',
    {
      service: z.string().describe('Service name to get summary for'),
    },
    async ({ service }) => {
      try {
        const summary = await queries.getServiceSummary(service);

        if (!summary.service) {
          return {
            content: [{
              type: 'text' as const,
              text: `Service "${service}" not found. Use list_services to see available services.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              service: {
                name: summary.service.name,
                ...summary.service.properties,
              },
              apis: summary.apis.map((a) => ({
                name: a.name,
                ...a.properties,
              })),
              databases: summary.databases.map((d) => ({
                name: d.name,
                ...d.properties,
              })),
              dependsOn: summary.dependencies.map((d) => ({
                name: d.name,
                type: d.label,
              })),
              dependedOnBy: summary.dependents.map((d) => ({
                name: d.name,
                type: d.label,
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
