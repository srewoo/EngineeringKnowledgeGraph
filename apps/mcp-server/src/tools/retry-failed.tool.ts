/**
 * MCP Tool: retry_failed
 *
 * Finds all repos whose latest ingestion FAILED (from SQLite)
 * and retriggers ingestion for them in the background.
 * Returns immediately with a job ID for polling.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqliteRepository } from '@ekg/storage';
import type { IngestionService } from '@ekg/worker';
import { createLogger } from '@ekg/shared';

export function registerRetryFailedTool(
  server: McpServer,
  sqliteRepo: SqliteRepository,
  ingestionService: IngestionService,
  token: string,
): void {
  const logger = createLogger({ service: 'retry-failed-tool' });

  // In-memory progress for retry jobs
  const retryJobs = new Map<string, {
    status: 'RUNNING' | 'COMPLETED';
    total: number;
    retried: number;
    succeeded: number;
    failedAgain: number;
    currentRepo: string;
    results: { repo: string; status: string; error?: string }[];
    startedAt: string;
  }>();

  server.tool(
    'retry_failed',
    'Retry all repos whose latest ingestion FAILED. Runs in background. Pass "status" as the action to poll progress of a retry job, or "start" to begin retrying.',
    {
      action: z.enum(['start', 'status']).describe('"start" to retry failed repos, "status" to check retry progress'),
      jobId: z.string().optional().describe('Retry job ID (required for "status" action)'),
    },
    async ({ action, jobId }) => {
      try {
        if (action === 'status') {
          if (!jobId) {
            // List all retry jobs
            const jobs = Array.from(retryJobs.entries()).map(([id, j]) => ({
              id,
              status: j.status,
              progress: `${j.retried}/${j.total}`,
              succeeded: j.succeeded,
              failedAgain: j.failedAgain,
              currentRepo: j.currentRepo,
            }));
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(jobs.length > 0 ? jobs : 'No retry jobs found', null, 2),
              }],
            };
          }

          const job = retryJobs.get(jobId);
          if (!job) {
            return {
              content: [{ type: 'text' as const, text: `No retry job found with ID "${jobId}"` }],
            };
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                jobId,
                ...job,
                results: job.results.slice(-10), // Last 10 results
              }, null, 2),
            }],
          };
        }

        // action === 'start'
        const failedJobs = sqliteRepo.getFailedJobs();

        if (failedJobs.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No failed repos found! All repos ingested successfully.',
            }],
          };
        }

        const retryJobId = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        retryJobs.set(retryJobId, {
          status: 'RUNNING',
          total: failedJobs.length,
          retried: 0,
          succeeded: 0,
          failedAgain: 0,
          currentRepo: '',
          results: [],
          startedAt: new Date().toISOString(),
        });

        logger.info({
          retryJobId,
          failedCount: failedJobs.length,
          repos: failedJobs.map((j) => j.repoUrl),
        }, 'Retrying failed repos');

        // Run in background
        (async () => {
          for (const failedJob of failedJobs) {
            const job = retryJobs.get(retryJobId)!;
            job.currentRepo = failedJob.repoUrl;

            try {
              logger.info({
                retryJobId,
                repo: failedJob.repoUrl,
                progress: `${job.retried + 1}/${job.total}`,
                previousError: failedJob.error,
              }, 'Retrying failed repo');

              const result = await ingestionService.ingest({
                repoUrl: failedJob.repoUrl,
                branch: failedJob.branch,
                token,
              });

              if (result.status === 'COMPLETED') {
                job.succeeded++;
                job.results.push({ repo: failedJob.repoUrl, status: 'SUCCESS' });
                logger.info({ retryJobId, repo: failedJob.repoUrl }, 'Retry succeeded');
              } else {
                job.failedAgain++;
                job.results.push({
                  repo: failedJob.repoUrl,
                  status: 'FAILED_AGAIN',
                  error: result.error,
                });
                logger.warn({ retryJobId, repo: failedJob.repoUrl, error: result.error }, 'Retry failed again');
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              job.failedAgain++;
              job.results.push({ repo: failedJob.repoUrl, status: 'FAILED_AGAIN', error: message });
              logger.error({ retryJobId, repo: failedJob.repoUrl, error: message }, 'Retry crashed');
            }

            job.retried++;
          }

          const finalJob = retryJobs.get(retryJobId)!;
          finalJob.status = 'COMPLETED';
          finalJob.currentRepo = '';

          logger.info({
            retryJobId,
            total: finalJob.total,
            succeeded: finalJob.succeeded,
            failedAgain: finalJob.failedAgain,
          }, 'Retry batch completed');
        })().catch((error) => {
          logger.error({ retryJobId, error: String(error) }, 'Retry batch crashed');
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              retryJobId,
              failedReposFound: failedJobs.length,
              repos: failedJobs.map((j) => ({
                url: j.repoUrl,
                previousError: j.error,
              })),
              message: `Retrying ${failedJobs.length} failed repos in background. Use retry_failed(action: "status", jobId: "${retryJobId}") to poll progress.`,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Retry failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
