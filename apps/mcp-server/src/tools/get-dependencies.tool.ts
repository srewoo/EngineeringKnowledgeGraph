/**
 * MCP Tool: get_dependencies
 *
 * Get direct and transitive dependencies of a service.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerGetDependenciesTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'get_dependencies',
    'Get all dependencies of a service — databases, APIs, other services it calls, and modules it imports. Supports multi-hop traversal for transitive dependencies.',
    {
      service: z.string().describe('Service name to query dependencies for'),
      depth: z.number().default(2).describe('Traversal depth (1 = direct only, up to 10)'),
      excludeNpm: z.boolean().default(true).describe('Exclude npm:* modules (third-party noise)'),
      excludeLabels: z.array(z.string()).optional().describe('Node labels to exclude from the path (e.g. ["File", "Module"])'),
    },
    async ({ service, depth, excludeNpm, excludeLabels }) => {
      try {
        const deps = await queries.getDependencies(service, depth, { excludeNpm, excludeLabels });

        if (deps.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No dependencies found for service "${service}". Verify the service name with list_services.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              service,
              depth,
              dependencyCount: deps.length,
              dependencies: deps.map((d) => ({
                dependsOn: d.dependsOn,
                relationship: d.relationshipType,
                confidence: d.confidence,
                depth: d.depth,
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
