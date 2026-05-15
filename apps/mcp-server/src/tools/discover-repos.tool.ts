/**
 * MCP Tool: discover_repos
 *
 * Discover all repos in GitLab groups before ingestion.
 * Returns the list with sizes so the user can review.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitLabClient } from '@ekg/parser';

export interface DiscoverReposConfig {
  readonly gitlabUrl: string;
  readonly token: string;
  readonly maxRepoSizeMb: number;
}

export function registerDiscoverReposTool(
  server: McpServer,
  config: DiscoverReposConfig,
): void {
  const gitlabClient = new GitLabClient();

  server.tool(
    'discover_repos',
    'Discover all active (non-archived) repositories in GitLab groups. Returns repo names, sizes, and branches. Use before bulk_ingest to preview what will be ingested.',
    {
      groupIds: z.string().describe('Comma-separated GitLab group IDs to scan (e.g. "123,456")'),
    },
    async ({ groupIds }) => {
      try {
        if (!config.token) {
          return {
            content: [{
              type: 'text' as const,
              text: 'GIT_TOKEN is not set in environment. Required for GitLab API access.',
            }],
            isError: true,
          };
        }

        const parsedGroupIds = groupIds.split(',').map((id) => parseInt(id.trim(), 10));

        const repos = await gitlabClient.discoverRepos({
          gitlabUrl: config.gitlabUrl,
          token: config.token,
          groupIds: parsedGroupIds,
          maxRepoSizeMb: config.maxRepoSizeMb,
          includeArchived: false,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              totalRepos: repos.length,
              maxSizeLimitMb: config.maxRepoSizeMb,
              repos: repos.map((r) => ({
                name: r.fullPath,
                url: r.httpUrl,
                branch: r.defaultBranch,
                sizeMb: r.repoSizeMb,
                lastActivity: r.lastActivity,
                archived: r.archived,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Discovery failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
