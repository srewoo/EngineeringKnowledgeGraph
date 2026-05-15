/**
 * MCP Tool: data_freshness — reports per-repo freshness/drift state.
 *
 * Reads from the `repo_state` table populated by IngestionService on every
 * ingest attempt (success or failure). Returns counts plus a list of repos
 * whose last successful ingest is older than `staleAfterDays` (default 7).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import { RepoStateRepository, type SqliteRepository } from '@ekg/storage';

export function registerDataFreshnessTool(server: McpServer, sqliteRepo: SqliteRepository): void {
  const logger = createLogger({ service: 'data-freshness-tool' });
  const repo = new RepoStateRepository(sqliteRepo.getConnection());

  server.tool(
    'data_freshness',
    'Report per-repo last-ingested-at and surface repos that are stale (default >7 days since last successful ingest).',
    {
      staleAfterDays: z.number().int().positive().max(365).optional()
        .describe('Stale threshold in days. Default 7.'),
    },
    async ({ staleAfterDays }) => {
      try {
        const days = staleAfterDays ?? 7;
        const all = repo.getAll();
        const stale = repo.findStale(days);
        const lastUpdated = all[0]?.lastIngestedAt;
        const body = {
          totalRepos: all.length,
          freshRepos: all.length - stale.length,
          staleAfterDays: days,
          staleRepos: stale.map((s) => ({
            repoUrl: s.repoUrl,
            lastSha: s.lastSha,
            lastIngestedAt: s.lastIngestedAt,
            lastFailedAt: s.lastFailedAt,
            lastError: s.lastError,
          })),
          lastUpdated,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'data_freshness failed');
        return { content: [{ type: 'text' as const, text: `data_freshness failed: ${msg}` }], isError: true };
      }
    },
  );
}
