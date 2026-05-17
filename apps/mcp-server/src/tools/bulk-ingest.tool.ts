/**
 * MCP Tool: bulk_ingest
 *
 * Starts bulk ingestion in the BACKGROUND and returns immediately
 * with a job ID. Use get_ingestion_status to poll progress.
 * This prevents MCP timeout on long-running ingestions (1000+ repos).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BulkIngestionService } from '@ekg/worker';

export interface BulkIngestConfig {
  readonly gitlabUrl: string;
  readonly token: string;
  readonly maxRepoSizeMb: number;
  readonly concurrency: number;
}

export function registerBulkIngestTool(
  server: McpServer,
  bulkService: BulkIngestionService,
  config: BulkIngestConfig,
): void {
  server.tool(
    'bulk_ingest',
    `Start bulk ingestion of all repos from GitLab groups (runs in background). Returns a job ID immediately — use get_ingestion_status to poll progress. Repos > ${config.maxRepoSizeMb}MB are auto-skipped. Default concurrency: ${config.concurrency} (override via 'concurrency' param, 1–32).`,
    {
      groupIds: z.string().describe('Comma-separated GitLab group IDs to ingest (e.g. "123,456")'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(32)
        .optional()
        .describe(
          `Parallel repo workers (1–32). Lower values reduce Neo4j lock contention on large bulk runs. Default: ${config.concurrency}.`,
        ),
    },
    async ({ groupIds, concurrency }) => {
      try {
        if (!config.token) {
          return {
            content: [{
              type: 'text' as const,
              text: 'GIT_TOKEN is not set in environment. Required for GitLab API access and repo cloning.',
            }],
            isError: true,
          };
        }

        const parsedGroupIds = groupIds.split(',').map((id) => parseInt(id.trim(), 10));
        const effectiveConcurrency = concurrency ?? config.concurrency;

        // Start in background — returns immediately
        const bulkJobId = bulkService.startBulkIngest(
          config.gitlabUrl,
          config.token,
          parsedGroupIds,
          config.maxRepoSizeMb,
          effectiveConcurrency,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              bulkJobId,
              status: 'STARTED',
              message: 'Bulk ingestion started in the background. Use get_ingestion_status to poll progress.',
              config: {
                groupIds: parsedGroupIds,
                maxRepoSizeMb: config.maxRepoSizeMb,
                concurrency: effectiveConcurrency,
              },
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Bulk ingestion failed to start: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
