/**
 * MCP Tool: list_unresolved_http_calls
 *
 * Surfaces HTTP call sites the URL→API resolver couldn't link to a known
 * API node (Phase 1.5). Engineers use this to fix `serviceHosts` hints in
 * `ekg.config.json` and re-ingest.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UnresolvedHttpRepository } from '@ekg/storage';

export function registerListUnresolvedHttpCallsTool(
  server: McpServer,
  repo: UnresolvedHttpRepository,
): void {
  server.tool(
    'list_unresolved_http_calls',
    'List HTTP call sites the URL→API resolver could not link. Filter by repo, cap with limit.',
    {
      repo: z.string().optional().describe('Optional — scope to a specific repo URL.'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ repo: repoUrl, limit }) => {
      try {
        const rows = repo.list(repoUrl, limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ unresolved: rows, count: rows.length }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `list_unresolved_http_calls failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
