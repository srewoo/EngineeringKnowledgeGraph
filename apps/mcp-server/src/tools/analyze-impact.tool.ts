/**
 * MCP Tool: analyze_impact
 *
 * Impact analysis — find all nodes affected if a given node changes.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerAnalyzeImpactTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'analyze_impact',
    'Analyse the impact if a service, database, or API changes. Returns all upstream dependents that would be affected, with traversal paths and depth.',
    {
      node: z.string().describe('Name of the node to analyse impact for (e.g., "Couchbase", "AuthService")'),
      depth: z.number().default(3).describe('How many hops upstream to traverse (up to 10)'),
      onlyServices: z.boolean().default(false).describe('Only return Service nodes in the result (filters out File/Module noise)'),
      excludeNpm: z.boolean().default(true).describe('Exclude npm:* modules from the path'),
      excludeLabels: z.array(z.string()).optional().describe('Node labels to exclude from the traversal path'),
    },
    async ({ node, depth, onlyServices, excludeNpm, excludeLabels }) => {
      try {
        const impacts = await queries.analyzeImpact(node, depth, { onlyServices, excludeNpm, excludeLabels });

        if (impacts.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No upstream dependents found for "${node}". This node either doesn't exist or has no incoming dependencies.`,
            }],
          };
        }

        // Group by depth for readability
        const byDepth = new Map<number, typeof impacts[number][]>();
        for (const impact of impacts) {
          const existing = byDepth.get(impact.depth) ?? [];
          existing.push(impact);
          byDepth.set(impact.depth, existing);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              targetNode: node,
              totalAffected: impacts.length,
              impactByDepth: Object.fromEntries(
                [...byDepth.entries()].map(([d, items]) => [
                  `depth_${d}`,
                  items.map((i) => ({
                    node: i.affectedNode,
                    type: i.affectedLabel,
                    path: i.path,
                  })),
                ]),
              ),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Impact analysis failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
