/**
 * MCP Tool: adapter_query
 *
 * Generic capability dispatch — agent picks a capability and the router
 * fans out across adapters, merging results in priority order.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityRouter, McpAdapter, TimeRange } from '@ekg/adapters';

const timeRangeSchema = z
  .object({ fromIso: z.string().min(1), toIso: z.string().min(1) })
  .strict();

const capabilitySchema = z.enum([
  'metrics',
  'traces',
  'errors',
  'logs',
  'docs',
  'tickets',
  'usage',
  'alarms',
]);

const argsSchema = z.record(z.unknown());

export function registerAdapterQueryTool(server: McpServer, router: CapabilityRouter): void {
  server.tool(
    'adapter_query',
    'Run a capability query (metrics/errors/logs/docs/tickets/usage/alarms/traces) against all enabled MCP adapters supporting it. Returns merged results in priority order.',
    {
      capability: capabilitySchema,
      args: argsSchema,
    },
    async ({ capability, args }) => {
      if (!router.hasCapability(capability)) {
        return jsonResponse({
          error: `no adapter registered for capability: ${capability}`,
          capability,
        });
      }
      try {
        const results = await dispatch(router, capability, args);
        return jsonResponse({ capability, results });
      } catch (err) {
        return jsonResponse({
          capability,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

async function dispatch(
  router: CapabilityRouter,
  capability: z.infer<typeof capabilitySchema>,
  rawArgs: Record<string, unknown>,
): Promise<ReadonlyArray<{ adapterId: string; result: unknown }>> {
  switch (capability) {
    case 'metrics': {
      const { service, timeRange } = parseServiceTime(rawArgs);
      return router.route('metrics', (a: McpAdapter) =>
        a.getServiceMetrics ? a.getServiceMetrics(service, timeRange) : undefined,
      );
    }
    case 'errors': {
      const { service, timeRange } = parseServiceTime(rawArgs);
      return router.route('errors', (a) =>
        a.getErrors ? a.getErrors(service, timeRange) : undefined,
      );
    }
    case 'logs': {
      const query = requireString(rawArgs, 'query');
      const timeRange = requireTimeRange(rawArgs);
      return router.route('logs', (a) => (a.getLogs ? a.getLogs(query, timeRange) : undefined));
    }
    case 'docs': {
      const query = requireString(rawArgs, 'query');
      return router.route('docs', (a) => (a.searchDocs ? a.searchDocs(query) : undefined));
    }
    case 'tickets': {
      const query = requireString(rawArgs, 'query');
      return router.route('tickets', (a) => (a.searchTickets ? a.searchTickets(query) : undefined));
    }
    case 'usage': {
      const event = requireString(rawArgs, 'event');
      const timeRange = requireTimeRange(rawArgs);
      return router.route('usage', (a) => (a.getUsage ? a.getUsage(event, timeRange) : undefined));
    }
    case 'alarms': {
      const timeRange = requireTimeRange(rawArgs);
      return router.route('alarms', (a) => (a.getAlarms ? a.getAlarms(timeRange) : undefined));
    }
    case 'traces': {
      const traceId = requireString(rawArgs, 'traceId');
      return router.route('traces', (a) => (a.getTrace ? a.getTrace(traceId) : undefined));
    }
    default:
      throw new Error(`unsupported capability: ${capability as string}`);
  }
}

function parseServiceTime(args: Record<string, unknown>): { service: string; timeRange: TimeRange } {
  return { service: requireString(args, 'service'), timeRange: requireTimeRange(args) };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`missing required string arg: ${key}`);
  return v;
}

function requireTimeRange(args: Record<string, unknown>): TimeRange {
  const parsed = timeRangeSchema.safeParse(args['timeRange']);
  if (!parsed.success) throw new Error('missing required arg: timeRange { fromIso, toIso }');
  return parsed.data;
}

function jsonResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
