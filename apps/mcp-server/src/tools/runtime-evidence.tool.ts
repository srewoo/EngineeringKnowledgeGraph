/**
 * MCP Tool: runtime_evidence
 *
 * Surfaces whatever RuntimeSignalProviders are registered. Phase 5 ships
 * with an empty registry; Phase 6 will plug in Datadog / Loki / etc.
 *
 * Output is intentionally permissive — callers should treat absence of a
 * field as "this provider does not support that capability".
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  RuntimeProviderRegistry,
  RuntimeHealth,
  RuntimeEdgeEvidence,
} from '@ekg/advanced';

export function registerRuntimeEvidenceTool(
  server: McpServer,
  registry: RuntimeProviderRegistry,
): void {
  server.tool(
    'runtime_evidence',
    'Fetch runtime corroboration (errors, traces, metrics, logs) for a service or service-pair from registered RuntimeSignalProviders. No providers are configured by default in Phase 5 — this tool returns a clean "no signal" response in that case.',
    {
      service: z.string().min(1).optional(),
      serviceA: z.string().min(1).optional(),
      serviceB: z.string().min(1).optional(),
      timeRangeMin: z.number().int().min(1).max(7 * 24 * 60).default(60),
    },
    async ({ service, serviceA, serviceB, timeRangeMin }) => {
      const providers = registry.list();
      if (providers.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              providers: [],
              message: 'No runtime providers configured. See Phase 6.',
            }, null, 2),
          }],
        };
      }

      const health: Array<{ provider: string; result: RuntimeHealth | { error: string } }> = [];
      const evidence: Array<{ provider: string; result: RuntimeEdgeEvidence | { error: string } }> = [];

      if (service) {
        for (const p of providers) {
          if (typeof p.getServiceHealth !== 'function') continue;
          try {
            const result = await p.getServiceHealth(service, timeRangeMin);
            health.push({ provider: p.id, result });
          } catch (err) {
            health.push({ provider: p.id, result: { error: errMsg(err) } });
          }
        }
      }
      if (serviceA && serviceB) {
        for (const p of providers) {
          if (typeof p.findRuntimeEvidence !== 'function') continue;
          try {
            const result = await p.findRuntimeEvidence(serviceA, serviceB, timeRangeMin);
            evidence.push({ provider: p.id, result });
          } catch (err) {
            evidence.push({ provider: p.id, result: { error: errMsg(err) } });
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            providers: providers.map((p) => ({ id: p.id, capabilities: p.capabilities })),
            health,
            evidence,
            timeRangeMin,
          }, null, 2),
        }],
      };
    },
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
