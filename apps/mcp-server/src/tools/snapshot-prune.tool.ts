/**
 * MCP Tool: snapshot_prune — delete auto-* snapshots older than the most
 * recent N. Manual labels (no `auto-` prefix) are always preserved.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SnapshotRepository } from '@ekg/storage';
import { SCHEDULER_LABEL_PREFIX } from '@ekg/advanced';

export const PRUNE_DEFAULT_KEEP = 6;

export function registerSnapshotPruneTool(server: McpServer, repo: SnapshotRepository): void {
  server.tool(
    'snapshot_prune',
    'Delete auto-* snapshots older than the most recent N (default 6). Manual labels are preserved.',
    {
      keep: z.number().int().min(1).max(100).default(PRUNE_DEFAULT_KEEP),
    },
    async ({ keep }) => {
      try {
        const auto = repo.listByPrefix(SCHEDULER_LABEL_PREFIX);
        const toDelete = auto.slice(keep);
        const deleted: string[] = [];
        for (const s of toDelete) {
          if (repo.deleteById(s.id)) deleted.push(s.label);
        }
        const body = {
          kept: Math.min(auto.length, keep),
          deleted: deleted.length,
          deletedLabels: deleted,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `snapshot_prune failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
