/**
 * MCP Tool: submit_feedback — record a thumbs-up/down on an answer.
 *
 * Persists into `answer_feedback`. The `traceId` should be the one returned
 * in the agent's AnswerEnvelope (Phase 4 observability).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import { FeedbackRepository } from '@ekg/observability';
import type { SqliteRepository } from '@ekg/storage';

export function registerSubmitFeedbackTool(server: McpServer, sqliteRepo: SqliteRepository): void {
  const logger = createLogger({ service: 'submit-feedback-tool' });
  const repo = new FeedbackRepository(sqliteRepo.getConnection());

  server.tool(
    'submit_feedback',
    'Record thumbs-up/down feedback on a previously-answered question. Pass the traceId from the answer envelope.',
    {
      traceId: z.string().min(1),
      verdict: z.enum(['up', 'down']),
      question: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ traceId, verdict, question, reason }) => {
      try {
        const row = repo.upsert({ traceId, verdict, question, ...(reason ? { reason } : {}) });
        logger.info({ traceId, verdict }, 'feedback recorded');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ id: row.id, traceId: row.traceId, verdict: row.verdict, createdAt: row.createdAt }, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'feedback insert failed');
        return { content: [{ type: 'text' as const, text: `submit_feedback failed: ${msg}` }], isError: true };
      }
    },
  );
}
