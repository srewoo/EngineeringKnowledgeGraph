/**
 * MCP Tool: lineage (Phase G)
 *
 * Today: one mode — `apis_for_column` — answers "if I rename column X,
 * which APIs break?". Backed by the `EXPOSES_DATA` edges derived during
 * ingestion by the DataLineagePass.
 *
 * Later modes (left for future slices):
 *   - `columns_for_api`  — what data does this endpoint expose?
 *   - `pii_surface`      — which services / APIs touch PII columns?
 *   - `frontend_for_field` — UI component → API field → DB column trail
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerLineageTool(server: McpServer, queries: GraphQueries): void {
  server.tool(
    'lineage',
    'Phase G data lineage: trace database columns to the APIs that expose them. Useful for "rename impact" / "what breaks if I drop this column" questions. Coverage is best-effort — only matches when the API has an OpenAPI/Swagger schema OR an inferred request/response shape.',
    {
      mode: z.enum(['apis_for_column']).default('apis_for_column'),
      target: z.string().min(1).describe('Column name (e.g. "email") or `<table>.<column>` qualifier.'),
      limit: z.number().int().positive().max(100).default(25),
    },
    async ({ mode, target, limit }) => {
      try {
        const rows = await queries.apisExposingColumn(target, limit);
        return jsonResponse({ mode, target, count: rows.length, apis: rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Lineage query failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
