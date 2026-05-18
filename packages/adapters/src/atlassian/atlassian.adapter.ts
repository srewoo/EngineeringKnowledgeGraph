/**
 * AtlassianAdapter — wraps an external Atlassian (Jira + Confluence) MCP
 * server. Capabilities: `docs` (Confluence search) + `tickets` (Jira search).
 *
 * Tool names default to the Atlassian Rovo MCP convention but can be
 * overridden via `config.tools.{searchDocs,searchTickets}` in
 * `ekg.config.json`.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  DocResult,
  McpAdapter,
  TicketResult,
} from '../adapter.interface.js';
import { McpStdioClient, splitCommand, tryParseJsonContent } from '../mcp.client.js';

const CAPS: readonly AdapterCapability[] = ['docs', 'tickets'];
const DEFAULT_DOCS_TOOL = 'confluence_search';
const DEFAULT_TICKETS_TOOL = 'jira_search';

const logger = createLogger({ service: 'adapters.atlassian' });

export interface AtlassianAdapterOptions {
  readonly context: AdapterContext;
  readonly command: string;
  readonly args?: readonly string[];
  /** Tool-name overrides (so different upstream MCP servers can be plugged in). */
  readonly tools?: { searchDocs?: string; searchTickets?: string };
}

export class AtlassianAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;
  private readonly client: McpStdioClient;
  private readonly tools: Required<NonNullable<AtlassianAdapterOptions['tools']>>;
  private connected = false;

  constructor(opts: AtlassianAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.client = new McpStdioClient({
      command: opts.command,
      ...(opts.args ? { args: opts.args } : {}),
      env: opts.context.env,
    });
    this.tools = {
      searchDocs: opts.tools?.searchDocs ?? DEFAULT_DOCS_TOOL,
      searchTickets: opts.tools?.searchTickets ?? DEFAULT_TICKETS_TOOL,
    };
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
    logger.info({ adapter: this.id }, 'atlassian adapter connected');
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  async searchDocs(query: string): Promise<DocResult[]> {
    const out = await this.client.callTool(this.tools.searchDocs, { query, limit: 10 });
    if (out.isError) return [];
    const parsed = tryParseJsonContent(out.content);
    return normaliseDocs(parsed, this.id);
  }

  async searchTickets(query: string): Promise<TicketResult[]> {
    const out = await this.client.callTool(this.tools.searchTickets, { query, limit: 25 });
    if (out.isError) return [];
    const parsed = tryParseJsonContent(out.content);
    return normaliseTickets(parsed);
  }
}

export function createAtlassianAdapter(ctx: AdapterContext): AtlassianAdapter {
  const cmd = (ctx.config['command'] as string | undefined)
    ?? (typeof ctx.env['COMMAND'] === 'string' ? ctx.env['COMMAND'] : undefined)
    ?? 'npx';
  const args = (ctx.config['args'] as string[] | undefined)
    ?? ['-y', '@aashari/mcp-server-atlassian-jira'];
  // Allow `command: "npx -y @x/server"` shorthand.
  if (cmd.includes(' ') && !args) {
    const split = splitCommand(cmd);
    return new AtlassianAdapter({
      context: ctx,
      command: split.command,
      args: split.args,
      ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { searchDocs?: string; searchTickets?: string } } : {}),
    });
  }
  return new AtlassianAdapter({
    context: ctx,
    command: cmd,
    args,
    ...(ctx.config['tools'] ? { tools: ctx.config['tools'] as { searchDocs?: string; searchTickets?: string } } : {}),
  });
}

function normaliseDocs(parsed: unknown, source: string): DocResult[] {
  const list = asList(parsed);
  return list.map((d, i) => ({
    id: String((d['id'] ?? d['pageId'] ?? d['key'] ?? `doc-${i}`)),
    title: String(d['title'] ?? d['name'] ?? d['summary'] ?? 'untitled'),
    url: String(d['url'] ?? (isRecord(d['_links']) ? d['_links']['webui'] : undefined) ?? d['link'] ?? ''),
    ...(d['excerpt'] || d['snippet']
      ? { snippet: String(d['excerpt'] ?? d['snippet']) }
      : {}),
    source,
  }));
}

function normaliseTickets(parsed: unknown): TicketResult[] {
  const list = asList(parsed);
  return list.map((t, i) => ({
    id: String(t['id'] ?? t['key'] ?? `t-${i}`),
    key: String(t['key'] ?? t['id'] ?? `t-${i}`),
    title: String(t['summary'] ?? t['title'] ?? 'untitled'),
    status: String(t['status'] ?? t['statusName'] ?? 'unknown'),
    ...(t['priority'] ? { priority: String(t['priority']) } : {}),
    ...(t['service'] ? { service: String(t['service']) } : {}),
  }));
}

function asList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isRecord) as Array<Record<string, unknown>>;
  if (isRecord(parsed)) {
    for (const k of ['results', 'issues', 'pages', 'data', 'items']) {
      const v = parsed[k];
      if (Array.isArray(v)) return v.filter(isRecord) as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
