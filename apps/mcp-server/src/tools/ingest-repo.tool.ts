/**
 * MCP Tool: ingest_repo
 *
 * Triggers ingestion of a Git repository into the knowledge graph.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IngestionService } from '@ekg/worker';

export function registerIngestRepoTool(
  server: McpServer,
  ingestionService: IngestionService,
): void {
  server.tool(
    'ingest_repo',
    'Clone a Git repository and ingest its code into the knowledge graph. Extracts services, APIs, databases, dependencies, and relationships.',
    {
      url: z.string().describe('Git repository URL (HTTPS or SSH)'),
      branch: z.string().default('main').describe('Branch to ingest'),
      token: z.string().optional().describe('Git access token for private repos'),
    },
    async ({ url, branch, token }) => {
      try {
        const job = await ingestionService.ingest({
          repoUrl: url,
          branch,
          token,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: job.status,
              jobId: job.id,
              repoUrl: job.repoUrl,
              commitSha: job.commitSha,
              filesProcessed: job.filesProcessed,
              nodesCreated: job.nodesCreated,
              edgesCreated: job.edgesCreated,
              error: job.error,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Ingestion failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
