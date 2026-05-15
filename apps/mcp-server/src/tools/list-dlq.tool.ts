/**
 * MCP Tool: list_dlq
 *
 * Lists permanently-failed repos from the SQLite dead-letter queue.
 * Optional filters: bulkJobId (scope to one bulk run), category (e.g. NEO4J_LOCK).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DlqRepository } from '@ekg/storage';
import { ERROR_CATEGORIES } from '@ekg/shared';
import type { ErrorCategory } from '@ekg/shared';

export function registerListDlqTool(server: McpServer, dlq: DlqRepository): void {
  server.tool(
    'list_dlq',
    'List unresolved repos from the bulk-ingest dead-letter queue. Filter by bulkJobId or error category.',
    {
      bulkJobId: z.string().optional().describe('Optional — filter to a specific bulk job.'),
      category: z.enum(ERROR_CATEGORIES).optional().describe('Optional — filter by error category.'),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ bulkJobId, category, limit }) => {
      try {
        const rows = category
          ? dlq.listByCategory(category as ErrorCategory, bulkJobId)
          : dlq.listUnresolved(bulkJobId);
        const counts = dlq.countByCategory(bulkJobId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              unresolved: rows.slice(0, limit),
              totalUnresolved: rows.length,
              counts,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `list_dlq failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
