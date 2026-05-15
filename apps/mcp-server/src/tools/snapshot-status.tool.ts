/**
 * MCP Tool: snapshot_status — surface scheduler cadence, latest snapshot, next-fire.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SnapshotRepository } from '@ekg/storage';
import type { SnapshotScheduler } from '@ekg/advanced';

export function registerSnapshotStatusTool(
  server: McpServer,
  repo: SnapshotRepository,
  scheduler: SnapshotScheduler | null,
  cadence: string,
): void {
  server.tool(
    'snapshot_status',
    'Report the snapshot scheduler cadence, latest captured snapshot, and the next scheduled fire time.',
    {},
    async () => {
      try {
        const latest = repo.latest();
        const next = scheduler?.nextFireAt() ?? null;
        const body = {
          schedule: cadence,
          lastSnapshot: latest ? { label: latest.label, createdAt: latest.createdAt } : null,
          nextFireAt: next ? next.toISOString() : null,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `snapshot_status failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
