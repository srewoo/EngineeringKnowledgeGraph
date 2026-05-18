/**
 * MixpanelAdapter — wraps an external Mixpanel MCP server. Capability: `usage`.
 *
 * Default tool: `query_event_counts(event, fromIso, toIso)`. Override via
 * `config.tools.getUsage` in `ekg.config.json`.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  McpAdapter,
  TimeRange,
  UsageResult,
} from '../adapter.interface.js';
import { McpStdioClient, splitCommand, tryParseJsonContent } from '../mcp.client.js';

const CAPS: readonly AdapterCapability[] = ['usage'];
const DEFAULT_USAGE_TOOL = 'query_event_counts';

const logger = createLogger({ service: 'adapters.mixpanel' });

export interface MixpanelAdapterOptions {
  readonly context: AdapterContext;
  readonly command: string;
  readonly args?: readonly string[];
  readonly tools?: { getUsage?: string };
}

export class MixpanelAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;
  private readonly client: McpStdioClient;
  private readonly toolName: string;
  private connected = false;

  constructor(opts: MixpanelAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.client = new McpStdioClient({
      command: opts.command,
      ...(opts.args ? { args: opts.args } : {}),
      env: opts.context.env,
    });
    this.toolName = opts.tools?.getUsage ?? DEFAULT_USAGE_TOOL;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
    logger.info({ adapter: this.id }, 'mixpanel adapter connected');
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  async getUsage(event: string, timeRange: TimeRange): Promise<UsageResult[]> {
    const out = await this.client.callTool(this.toolName, {
      event,
      from: timeRange.fromIso,
      to: timeRange.toIso,
    });
    if (out.isError) return [];
    const parsed = tryParseJsonContent(out.content);
    return normaliseUsage(parsed, event, timeRange);
  }
}

export function createMixpanelAdapter(ctx: AdapterContext): MixpanelAdapter {
  const cmd = (ctx.config['command'] as string | undefined) ?? 'npx';
  const args = (ctx.config['args'] as string[] | undefined)
    ?? ['-y', '@mixpanel/mcp-server'];
  if (cmd.includes(' ') && !ctx.config['args']) {
    const split = splitCommand(cmd);
    return new MixpanelAdapter({
      context: ctx,
      command: split.command,
      args: split.args,
      ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { getUsage?: string } } : {}),
    });
  }
  return new MixpanelAdapter({
    context: ctx,
    command: cmd,
    args,
    ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { getUsage?: string } } : {}),
  });
}

function normaliseUsage(parsed: unknown, event: string, range: TimeRange): UsageResult[] {
  const list = asList(parsed);
  if (list.length === 0 && isRecord(parsed)) {
    // Mixpanel sometimes returns a single summary object.
    return [
      {
        event: String(parsed['event'] ?? event),
        eventCount: Number(parsed['count'] ?? parsed['total'] ?? 0),
        uniqueUsers: Number(parsed['uniqueUsers'] ?? parsed['unique'] ?? 0),
        window: `${range.fromIso}/${range.toIso}`,
      },
    ];
  }
  return list.map((d) => ({
    event: String(d['event'] ?? event),
    eventCount: Number(d['count'] ?? d['eventCount'] ?? d['total'] ?? 0),
    uniqueUsers: Number(d['uniqueUsers'] ?? d['unique'] ?? 0),
    window: String(d['window'] ?? `${range.fromIso}/${range.toIso}`),
  }));
}

function asList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isRecord) as Array<Record<string, unknown>>;
  if (isRecord(parsed)) {
    for (const k of ['series', 'data', 'results', 'items']) {
      const v = parsed[k];
      if (Array.isArray(v)) return v.filter(isRecord) as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
