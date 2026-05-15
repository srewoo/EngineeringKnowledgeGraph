/**
 * MCP Tool: resolve_services
 *
 * Post-ingestion pass that links HTTP call URLs to known service nodes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ServiceResolver } from '@ekg/worker';

export function registerResolveServicesTool(
  server: McpServer,
  resolver: ServiceResolver,
): void {
  server.tool(
    'resolve_services',
    'Run a service resolution pass. Links HTTP call URLs to discovered service nodes, creating cross-service CALLS relationships. Run this after ingesting multiple repos.',
    {},
    async () => {
      try {
        const resolved = await resolver.resolve();

        if (resolved.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No new cross-service links resolved. This is normal if services don\'t reference each other by name in HTTP URLs, or if resolution has already been run.',
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              totalResolved: resolved.length,
              links: resolved.map((r) => ({
                from: r.sourceService,
                to: r.targetService,
                url: r.url,
                confidence: r.confidence,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Resolution failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
