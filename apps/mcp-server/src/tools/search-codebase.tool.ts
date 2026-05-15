/**
 * MCP Tool: search_codebase
 *
 * Search across the knowledge graph for nodes matching a query.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerSearchCodebaseTool(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.tool(
    'search_codebase',
    'Search the knowledge graph for services, databases, APIs, modules, or any other entity. Answers questions like "Where is Couchbase used?" or "Which files import express?"',
    {
      query: z.string().describe('Search term (e.g., "Couchbase", "UserService", "express")'),
      type: z.enum([
        'Service', 'API', 'Database', 'Repo', 'File',
        'Module', 'Config', 'MessageQueue', 'Owner', 'Team',
      ]).optional().describe('Filter by a single node type'),
      types: z.array(z.string()).optional().describe('Filter by multiple node types (OR). Overrides "type" if both provided.'),
      limit: z.number().default(20).describe('Max results to return (1-100)'),
    },
    async ({ query, type, types, limit }) => {
      try {
        const labelFilter = (types && types.length > 0) ? types : type;
        const results = await queries.searchNodes(query, labelFilter, Math.min(Math.max(limit, 1), 100));

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No results found for "${query}"${type ? ` (type: ${type})` : ''}. Try a broader search or ingest more repositories.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query,
              resultCount: results.length,
              results: results.map((r) => ({
                name: r.name,
                type: r.label,
                ...r.properties,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Search failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
