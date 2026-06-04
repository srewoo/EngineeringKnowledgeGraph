/**
 * MCP Tool: materialize_runtime_edges (Phase C)
 *
 * Triggers the RuntimeEdgesPass against a configured adapter. The pass fetches
 * observed service-to-service calls (e.g. Datadog APM service dependencies)
 * and writes `OBSERVED_CALL` edges between matching `Service` nodes — giving
 * agents a way to distinguish what the code *says* it calls (static
 * `CALLS_API` edges) from what actually happens in prod.
 *
 * Caller supplies the adapter id; we look it up in the AdapterRegistry. If
 * the adapter is missing, disabled, or doesn't expose service dependencies,
 * we return a structured no-op (never throw) so agents can recover.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdapterRegistry } from '@ekg/adapters';
import { RuntimeEdgesPass } from '@ekg/worker';
import type { Neo4jClient } from '@ekg/graph';

export interface MaterializeRuntimeEdgesDeps {
  readonly registry?: AdapterRegistry;
  readonly neo4jClient: Neo4jClient;
}

export function registerMaterializeRuntimeEdgesTool(
  server: McpServer,
  deps: MaterializeRuntimeEdgesDeps,
): void {
  server.tool(
    'materialize_runtime_edges',
    'Phase C: fetch observed service-to-service calls from a runtime adapter (e.g. Datadog) and write them as OBSERVED_CALL edges between Service nodes. Idempotent — re-running over the same window refreshes timestamps and counters. Returns a summary including any unmatched services so you can see runtime traffic that points at services not yet ingested.',
    {
      adapterId: z.string().describe('Adapter id to pull from (must implement service dependency fetch — Datadog does).'),
      windowMinutes: z.number().int().min(5).max(60 * 24 * 7).default(60).describe('How far back to look (default 60min). Capped at 1 week.'),
      serviceNamePrefix: z.string().optional().describe('Optional prefix to strip from adapter-reported service names before matching graph Service nodes (e.g. "prod-").'),
    },
    async ({ adapterId, windowMinutes, serviceNamePrefix }) => {
      if (!deps.registry) {
        return jsonResponse({
          ok: false,
          reason: 'AdapterRegistry not configured on this server. Set up adapters via ekg.config.json.',
        });
      }
      const adapter = deps.registry.getById(adapterId);
      if (!adapter) {
        return jsonResponse({
          ok: false,
          reason: `Adapter "${adapterId}" not found. Use list_adapters to see configured adapters.`,
        });
      }

      const now = Date.now();
      const timeRange = {
        fromIso: new Date(now - windowMinutes * 60_000).toISOString(),
        toIso: new Date(now).toISOString(),
      };

      const pass = new RuntimeEdgesPass(deps.neo4jClient);
      const override = serviceNamePrefix
        ? (raw: string) => (raw.startsWith(serviceNamePrefix) ? raw.slice(serviceNamePrefix.length) : raw)
        : undefined;

      const result = await pass.run({
        adapter,
        timeRange,
        ...(override ? { serviceNameOverride: override } : {}),
      });

      return jsonResponse({
        ok: result.skipped === undefined,
        adapter: result.adapterId,
        window: timeRange,
        edgesObserved: result.edgesObserved,
        edgesMerged: result.edgesMerged,
        unmatchedCount: result.unmatched.length,
        // Cap the response size — full unmatched list is logged but only top 25 returned to the agent.
        unmatchedSample: result.unmatched.slice(0, 25),
        durationMs: result.durationMs,
        ...(result.skipped ? { skipped: result.skipped } : {}),
      });
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
