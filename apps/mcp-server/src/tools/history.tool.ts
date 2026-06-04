/**
 * MCP Tool: history (Phase B)
 *
 * Exposes the Commit / TOUCHED graph data that is already ingested when
 * EKG_GIT_HISTORY_ENABLED=true. Three sub-queries through one tool to keep
 * the MCP surface compact:
 *
 *   - file       — commits that touched a file path, newest first
 *   - authors    — authors ranked by commit count against a file ("who knows this code")
 *   - service    — recent commits touching any file inside a service
 *
 * Returns an empty result (not an error) when history ingestion was disabled —
 * agents can then suggest enabling EKG_GIT_HISTORY_ENABLED and re-ingesting.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerHistoryTool(server: McpServer, queries: GraphQueries): void {
  server.tool(
    'history',
    'Query git history captured in the graph: file change history, top authors per file, or recent commits within a service. Requires repos to have been ingested with EKG_GIT_HISTORY_ENABLED=true.',
    {
      mode: z.enum(['file', 'authors', 'service', 'mrs_by_project', 'mrs_by_author']).describe('What to query: "file" = commits touching a file, "authors" = top authors per file, "service" = recent commits inside a service, "mrs_by_project" = MRs persisted for a GitLab project path, "mrs_by_author" = MRs by a specific author'),
      target: z.string().describe('File path (file/authors), service name (service), GitLab projectPath (mrs_by_project), or username (mrs_by_author)'),
      limit: z.number().int().positive().max(100).default(20).describe('Max rows to return (capped at 100)'),
    },
    async ({ mode, target, limit }) => {
      try {
        if (mode === 'file') {
          const rows = await queries.fileHistory(target, limit);
          return jsonResponse({ mode, target, count: rows.length, commits: rows });
        }
        if (mode === 'authors') {
          const rows = await queries.whoTouchedFile(target, limit);
          return jsonResponse({ mode, target, count: rows.length, authors: rows });
        }
        if (mode === 'service') {
          const rows = await queries.serviceRecentCommits(target, limit);
          return jsonResponse({ mode, target, count: rows.length, commits: rows });
        }
        const by = mode === 'mrs_by_project' ? 'project' : 'author';
        const rows = await queries.listMrs(target, by, limit);
        return jsonResponse({ mode, target, count: rows.length, mrs: rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `History query failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
