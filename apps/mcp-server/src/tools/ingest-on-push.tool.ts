/**
 * MCP Tool: ingest_on_push — webhook stub for future GitLab integration.
 *
 * Validates the incoming repoUrl against an allow-list of regex patterns
 * (env: EKG_WEBHOOK_REPO_PATTERNS, comma-separated). On match, enqueues an
 * incremental ingest via IngestionService.ingest. Otherwise rejects.
 *
 * This is a *stub*. A full GitLab webhook receiver belongs in a dedicated
 * HTTP server, not the MCP transport. Track that as a follow-up.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import type { IngestionService } from '@ekg/worker';

export interface IngestOnPushDeps {
  readonly ingestionService: IngestionService;
  readonly token?: string;
  readonly defaultBranch?: string;
}

function compilePatterns(env: NodeJS.ProcessEnv = process.env): readonly RegExp[] {
  const raw = env['EKG_WEBHOOK_REPO_PATTERNS'];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((p) => new RegExp(p));
}

export function registerIngestOnPushTool(server: McpServer, deps: IngestOnPushDeps): void {
  const logger = createLogger({ service: 'ingest-on-push-tool' });
  const patterns = compilePatterns();

  server.tool(
    'ingest_on_push',
    'Webhook-style trigger to enqueue an incremental ingest after a push. Allow-listed by EKG_WEBHOOK_REPO_PATTERNS regex env. Stub for future GitLab webhook integration.',
    {
      repoUrl: z.string().min(1).describe('Repo URL to ingest.'),
      commitSha: z.string().min(1).describe('Commit SHA from the push event (informational; ingest re-resolves HEAD).'),
      branch: z.string().optional().describe('Branch ref. Defaults to "main" or EKG_DEFAULT_BRANCH.'),
    },
    async ({ repoUrl, commitSha, branch }) => {
      if (patterns.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'ingest_on_push refused: EKG_WEBHOOK_REPO_PATTERNS is empty. Configure an allow-list before enabling.',
          }],
          isError: true,
        };
      }
      const allowed = patterns.some((p) => p.test(repoUrl));
      if (!allowed) {
        logger.warn({ repoUrl }, 'webhook rejected: not in allow-list');
        return {
          content: [{ type: 'text' as const, text: `ingest_on_push refused: ${repoUrl} does not match any allow-list pattern.` }],
          isError: true,
        };
      }

      const useBranch = branch ?? deps.defaultBranch ?? 'main';
      // Fire-and-forget — do NOT await. Webhook callers expect a fast ack.
      void deps.ingestionService.ingest({
        repoUrl,
        branch: useBranch,
        ...(deps.token ? { token: deps.token } : {}),
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ repoUrl, err: msg }, 'webhook-triggered ingest failed');
      });

      logger.info({ repoUrl, commitSha, branch: useBranch }, 'webhook accepted; ingest enqueued');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ accepted: true, repoUrl, commitSha, branch: useBranch }, null, 2),
        }],
      };
    },
  );
}
