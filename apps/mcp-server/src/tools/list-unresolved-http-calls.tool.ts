/**
 * MCP Tool: list_unresolved_http_calls
 *
 * Surfaces HTTP call sites the URL→API resolver couldn't link to a known
 * API node (Phase 1.5). Engineers use this to fix `serviceHosts` hints in
 * `ekg.config.json` and re-ingest.
 *
 * Item 3 — also reports a first-class **resolution rate**: resolved
 * `CALLS_API` edges (from the graph) vs. unresolved call sites (from SQLite).
 * A low rate means impact analysis is blind to those cross-service hops, so
 * the rate is the metric to drive up.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UnresolvedHttpRepository } from '@ekg/storage';
import type { GraphQueries } from '@ekg/graph';

export function registerListUnresolvedHttpCallsTool(
  server: McpServer,
  repo: UnresolvedHttpRepository,
  queries: GraphQueries,
): void {
  server.tool(
    'list_unresolved_http_calls',
    'Cross-service HTTP call resolution. mode="stats" reports the resolution rate (resolved CALLS_API edges vs. unresolved call sites) with a per-reason breakdown — drive this rate up to make impact analysis complete. mode="list" returns the unresolved call sites themselves so you can add serviceHosts hints and re-ingest.',
    {
      mode: z.enum(['stats', 'list']).default('stats').describe('"stats" = resolution rate + per-reason histogram; "list" = the unresolved call sites'),
      repo: z.string().optional().describe('Optional — scope to a specific repo URL.'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ mode, repo: repoUrl, limit }) => {
      try {
        if (mode === 'list') {
          const rows = repo.list(repoUrl, limit);
          return jsonResponse({ mode, repo: repoUrl ?? 'all', unresolved: rows, count: rows.length });
        }
        const unresolved = repo.count(repoUrl);
        const byReason = repo.countByReason(repoUrl);
        // Resolved counts are global per tenant (CALLS_API edges aren't repo-tagged);
        // when scoped to a repo the rate is approximate but directionally honest.
        const { resolved, byConfidence } = await queries.httpResolutionStats();
        const total = resolved + unresolved;
        const resolutionRate = total === 0 ? null : Number((resolved / total).toFixed(4));
        return jsonResponse({
          mode,
          repo: repoUrl ?? 'all',
          resolved,
          unresolved,
          total,
          resolutionRate,
          resolvedByConfidence: byConfidence,
          unresolvedByReason: byReason,
        });
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

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
