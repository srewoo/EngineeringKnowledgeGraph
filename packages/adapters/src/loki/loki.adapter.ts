/**
 * LokiAdapter — wraps an external Grafana Loki MCP server. Capability: `logs`.
 *
 * Default tool: `query_logs(query, fromIso, toIso)`. The adapter translates
 * the agent's `getLogs(query, range)` call into a LogQL probe; the wrapped
 * MCP server is expected to do the actual HTTP fetch.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  ErrorResult,
  LogResult,
  McpAdapter,
  TimeRange,
} from '../adapter.interface.js';
import { mapServiceName, type ServiceMapping } from '../service.mapping.js';
import { McpStdioClient, splitCommand, tryParseJsonContent } from '../mcp.client.js';

// `errors` is derived from error-level logs — llmPLAN §6.4's loki.get_errors.
const CAPS: readonly AdapterCapability[] = ['logs', 'errors'];
const DEFAULT_LOGS_TOOL = 'query_logs';
const ERROR_LEVELS = new Set(['error', 'err', 'critical', 'crit', 'fatal', 'emerg', 'alert']);

const logger = createLogger({ service: 'adapters.loki' });

export interface LokiAdapterOptions {
  readonly context: AdapterContext;
  readonly command: string;
  readonly args?: readonly string[];
  readonly tools?: { getLogs?: string };
}

export class LokiAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;
  private readonly client: McpStdioClient;
  private readonly toolName: string;
  private connected = false;

  constructor(opts: LokiAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.client = new McpStdioClient({
      command: opts.command,
      ...(opts.args ? { args: opts.args } : {}),
      env: opts.context.env,
    });
    this.toolName = opts.tools?.getLogs ?? DEFAULT_LOGS_TOOL;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
    logger.info({ adapter: this.id }, 'loki adapter connected');
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  async getLogs(query: string, timeRange: TimeRange): Promise<LogResult[]> {
    const out = await this.client.callTool(this.toolName, {
      query,
      from: timeRange.fromIso,
      to: timeRange.toIso,
      limit: 200,
    });
    if (out.isError) return [];
    const parsed = tryParseJsonContent(out.content);
    return normaliseLogs(parsed);
  }

  /**
   * llmPLAN §6.4 — error-level log intelligence. Builds a LogQL selector for
   * the service, fetches via `getLogs`, keeps error-severity lines, and
   * aggregates by message so callers get "top errors" rather than raw lines.
   * Enables the combined query "why is person-service throwing errors?".
   */
  async getErrors(service: string, timeRange: TimeRange): Promise<ErrorResult[]> {
    const field = (this.context.config['serviceLabel'] as string | undefined) ?? 'app';
    const mapping = (this.context.config['serviceMapping'] as ServiceMapping | undefined) ?? 'auto';
    const value = mapServiceName(service, mapping);
    const query = `{${field}="${value}"} | level=~"(?i)error|err|crit|fatal"`;
    const logs = await this.getLogs(query, timeRange);
    const errorLogs = logs.filter((l) => ERROR_LEVELS.has(l.level.toLowerCase()));
    // If the wrapped server didn't tag levels, trust the LogQL filter above.
    const effective = errorLogs.length > 0 ? errorLogs : logs;
    return aggregateErrors(effective, value);
  }
}

/** Group error logs by message into ErrorResult[] (count + first/last seen). */
function aggregateErrors(logs: readonly LogResult[], service: string): ErrorResult[] {
  const byMessage = new Map<string, { count: number; first: string; last: string }>();
  for (const l of logs) {
    const key = l.message.slice(0, 500);
    const existing = byMessage.get(key);
    if (!existing) {
      byMessage.set(key, { count: 1, first: l.timestamp, last: l.timestamp });
    } else {
      existing.count += 1;
      if (l.timestamp < existing.first) existing.first = l.timestamp;
      if (l.timestamp > existing.last) existing.last = l.timestamp;
    }
  }
  return [...byMessage.entries()]
    .map(([message, v]) => ({ service, message, count: v.count, firstSeen: v.first, lastSeen: v.last }))
    .sort((a, b) => b.count - a.count);
}

export function createLokiAdapter(ctx: AdapterContext): LokiAdapter {
  const cmd = (ctx.config['command'] as string | undefined) ?? 'npx';
  const args = (ctx.config['args'] as string[] | undefined)
    ?? ['-y', '@grafana/mcp-loki'];
  if (cmd.includes(' ') && !ctx.config['args']) {
    const split = splitCommand(cmd);
    return new LokiAdapter({
      context: ctx,
      command: split.command,
      args: split.args,
      ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { getLogs?: string } } : {}),
    });
  }
  return new LokiAdapter({
    context: ctx,
    command: cmd,
    args,
    ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { getLogs?: string } } : {}),
  });
}

function normaliseLogs(parsed: unknown): LogResult[] {
  const list = asList(parsed);
  return list.map((entry) => ({
    service: String(entry['service'] ?? entry['app'] ?? 'unknown'),
    message: String(entry['message'] ?? entry['line'] ?? ''),
    level: String(entry['level'] ?? entry['severity'] ?? 'info'),
    timestamp: String(entry['timestamp'] ?? entry['ts'] ?? new Date().toISOString()),
  }));
}

function asList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isRecord) as Array<Record<string, unknown>>;
  if (isRecord(parsed)) {
    for (const k of ['streams', 'data', 'entries', 'logs', 'results']) {
      const v = parsed[k];
      if (Array.isArray(v)) return v.filter(isRecord) as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
