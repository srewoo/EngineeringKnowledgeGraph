/**
 * MCP Tool: retry_dlq
 *
 * Re-enqueue permanently-failed repos from the DLQ. Either pass an explicit
 * `repoUrls` array, or pass a `bulkJobId` (and optional `category`) to retry
 * everything currently unresolved in that scope.
 *
 * Wraps BulkIngestionService.startBulkIngestForList — the producer-consumer
 * pipeline is reused as-is.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DlqRepository } from '@ekg/storage';
import type { BulkIngestionService } from '@ekg/worker';
import { ERROR_CATEGORIES } from '@ekg/shared';
import type { ErrorCategory } from '@ekg/shared';

export interface RetryDlqDeps {
  readonly bulkService: BulkIngestionService;
  readonly dlq: DlqRepository;
  readonly token: string;
  readonly defaultConcurrency: number;
}

export function registerRetryDlqTool(server: McpServer, deps: RetryDlqDeps): void {
  server.tool(
    'retry_dlq',
    'Re-ingest repos sitting in the bulk DLQ. Pass repoUrls explicitly OR pass bulkJobId (with optional category) to retry everything unresolved.',
    {
      repoUrls: z.array(z.string().url()).optional().describe('Explicit list of repo URLs to retry.'),
      bulkJobId: z.string().optional().describe('Retry all unresolved repos for this bulk job.'),
      category: z.enum(ERROR_CATEGORIES).optional().describe('Filter bulkJobId scope by error category.'),
      concurrency: z.number().int().min(1).max(10).optional(),
    },
    async ({ repoUrls, bulkJobId, category, concurrency }) => {
      try {
        const urls: string[] = [];
        if (repoUrls && repoUrls.length > 0) {
          urls.push(...repoUrls);
        } else if (bulkJobId) {
          const rows = category
            ? deps.dlq.listByCategory(category as ErrorCategory, bulkJobId)
            : deps.dlq.listUnresolved(bulkJobId);
          urls.push(...rows.map((r) => r.repoUrl));
        } else {
          return {
            content: [{ type: 'text' as const, text: 'Provide either repoUrls or bulkJobId.' }],
            isError: true,
          };
        }

        if (urls.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No matching DLQ entries to retry.' }],
          };
        }

        const newJobId = deps.bulkService.startBulkIngestForList(
          urls, deps.token, concurrency ?? deps.defaultConcurrency,
        );

        // Mark resolved optimistically — if they fail again, the writeWorker
        // re-upserts them with a fresh attempts counter.
        for (const url of urls) {
          if (bulkJobId) deps.dlq.markResolved(deps.dlq.idForRepo(bulkJobId, url));
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              newBulkJobId: newJobId,
              retrying: urls.length,
              hint: `Poll get_ingestion_status with "${newJobId}".`,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `retry_dlq failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
