/**
 * MCP Tools: snapshot_graph + diff_snapshots
 *
 * Architecture-diff over time. `snapshot_graph` is on-demand and idempotent
 * by label — re-running with the same label overwrites that label's payload.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';
import type { SnapshotRepository } from '@ekg/storage';
import { createLogger } from '@ekg/shared';
import {
  Neo4jSnapshotSource,
  buildSnapshot,
  diff,
  snapshotByteSize,
  SNAPSHOT_WARN_BYTES,
  type SnapshotPayload,
} from '@ekg/advanced';

export function registerSnapshotGraphTool(
  server: McpServer,
  neo4j: Neo4jClient,
  repo: SnapshotRepository,
): void {
  const logger = createLogger({ service: 'snapshot-graph-tool' });
  server.tool(
    'snapshot_graph',
    'Capture a deterministic snapshot of the current architecture (services + inter-service edges + summary counts) and persist it under a label. Idempotent on label — same label overwrites.',
    {
      label: z.string().min(1).max(120).describe('Human label, e.g. "2026-05-monthly".'),
    },
    async ({ label }) => {
      try {
        const source = new Neo4jSnapshotSource(neo4j);
        const payload = await buildSnapshot(source);
        const bytes = snapshotByteSize(payload);
        if (bytes > SNAPSHOT_WARN_BYTES) {
          logger.warn({ label, bytes }, 'Snapshot payload exceeds 5MB warn threshold');
        }
        const saved = repo.save(label, JSON.stringify(payload));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              label,
              snapshotId: saved.id,
              capturedAt: saved.createdAt,
              bytes,
              summary: payload.summary,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `snapshot_graph failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

export function registerDiffSnapshotsTool(server: McpServer, repo: SnapshotRepository): void {
  server.tool(
    'diff_snapshots',
    'Diff two stored snapshots by label. Reports added/removed services, added/removed/changed inter-service edges, plus summary counts.',
    {
      from: z.string().min(1),
      to: z.string().min(1),
    },
    async ({ from, to }) => {
      try {
        const a = repo.getByLabel(from);
        const b = repo.getByLabel(to);
        if (!a || !b) {
          const missing = [!a ? from : null, !b ? to : null].filter(Boolean);
          return {
            content: [{ type: 'text' as const, text: `Snapshot not found for label(s): ${missing.join(', ')}. Known labels: ${repo.listLabels().join(', ') || '(none)'}` }],
            isError: true,
          };
        }
        const prev = JSON.parse(a.payload) as SnapshotPayload;
        const curr = JSON.parse(b.payload) as SnapshotPayload;
        const result = diff(prev, curr);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ from, to, ...result }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `diff_snapshots failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
