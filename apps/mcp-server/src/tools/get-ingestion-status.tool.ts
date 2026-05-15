/**
 * MCP Tool: get_ingestion_status
 *
 * Check the status of:
 * 1. Individual repo ingestion jobs (from SQLite)
 * 2. Bulk ingestion jobs (from in-memory tracker)
 *
 * Pass a repo URL to check a single repo, or a bulk job ID to check bulk progress.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqliteRepository } from '@ekg/storage';
import type { BulkIngestionService } from '@ekg/worker';

export function registerGetIngestionStatusTool(
  server: McpServer,
  sqliteRepo: SqliteRepository,
  bulkService: BulkIngestionService,
): void {
  server.tool(
    'get_ingestion_status',
    'Check ingestion status. Pass a repo URL for single repo status, a bulk job ID (starts with "bulk-") for bulk progress, or "all" to list all bulk jobs.',
    {
      query: z.string().describe('Repo URL, bulk job ID (e.g. "bulk-1234..."), or "all" for all bulk jobs'),
    },
    async ({ query }) => {
      try {
        // Bulk job progress
        if (query.startsWith('bulk-')) {
          const progress = bulkService.getProgress(query);
          if (!progress) {
            return {
              content: [{
                type: 'text' as const,
                text: `No bulk job found with ID "${query}". Use "all" to list active jobs.`,
              }],
            };
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                bulkJobId: progress.bulkJobId,
                status: progress.status,
                progress: `${progress.totalIngested + progress.totalFailed}/${progress.totalDiscovered}`,
                totalDiscovered: progress.totalDiscovered,
                totalIngested: progress.totalIngested,
                totalFailed: progress.totalFailed,
                totalSkipped: progress.totalSkipped,
                currentRepo: progress.currentRepo || '(idle)',
                startedAt: progress.startedAt,
                updatedAt: progress.updatedAt,
                completedAt: progress.completedAt,
                failedRepos: progress.failedRepos.slice(0, 10),
                recentSuccess: progress.successRepos.slice(-5).map((r) => r.name),
              }, null, 2),
            }],
          };
        }

        // List all bulk jobs
        if (query === 'all') {
          const bulkJobs = bulkService.listJobs();
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                bulkJobs: bulkJobs.length > 0 ? bulkJobs : 'No bulk jobs found',
                tip: 'Pass a bulk job ID to see detailed progress',
              }, null, 2),
            }],
          };
        }

        // Single repo status
        const jobs = sqliteRepo.getJobsByRepo(query);

        if (jobs.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No ingestion jobs found for "${query}". Use ingest_repo to start ingestion.`,
            }],
          };
        }

        const latest = jobs[0]!;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              repo: query,
              totalJobs: jobs.length,
              latest: {
                jobId: latest.id,
                status: latest.status,
                branch: latest.branch,
                commitSha: latest.commitSha,
                startedAt: latest.startedAt,
                completedAt: latest.completedAt,
                filesProcessed: latest.filesProcessed,
                nodesCreated: latest.nodesCreated,
                edgesCreated: latest.edgesCreated,
                error: latest.error,
              },
              history: jobs.slice(1, 5).map((j) => ({
                jobId: j.id,
                status: j.status,
                startedAt: j.startedAt,
                completedAt: j.completedAt,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Query failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
