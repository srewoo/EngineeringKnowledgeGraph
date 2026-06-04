/**
 * MCP Tool: coverage (Phase E)
 *
 * Two modes over `TestCase` + `TESTS` edges populated by the ingestion
 * `TestCasesPass`:
 *
 *   - `tests_for` — list TestCase nodes that cover a given file
 *   - `untested_in` — list files inside a service that have no TESTS edge
 *
 * Coverage is inferred from imports today (not runtime/coverage data), so
 * the answers reflect *which test file imports this code*, not *which lines
 * are executed*. That's intentionally conservative — a later pass can
 * upgrade individual edges with real coverage signal.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerCoverageTool(server: McpServer, queries: GraphQueries): void {
  server.tool(
    'coverage',
    'Phase E: query test coverage in the graph. "tests_for" returns TestCase nodes that import a given file; "untested_in" lists files inside a service that have no incoming TESTS edge. Coverage is inferred from imports — a TestCase that imports a file is assumed to exercise it.',
    {
      mode: z.enum(['tests_for', 'untested_in']).describe('"tests_for" = tests that cover a file path; "untested_in" = files with no test coverage inside a service'),
      target: z.string().describe('File path (tests_for) or service name (untested_in)'),
      limit: z.number().int().positive().max(100).default(20),
    },
    async ({ mode, target, limit }) => {
      try {
        if (mode === 'tests_for') {
          const rows = await queries.testsCoveringFile(target, limit);
          return jsonResponse({ mode, target, count: rows.length, tests: rows });
        }
        const rows = await queries.untestedFilesInService(target, limit);
        return jsonResponse({ mode, target, count: rows.length, files: rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Coverage query failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
