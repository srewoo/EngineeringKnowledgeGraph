/**
 * AtlassianAdapter — Jira (tickets) + Confluence (docs) over REST v3 / wiki.
 *
 * Capabilities: tickets, docs.
 * Backed by raw `fetch` with Basic auth (email:apiToken). No SDK.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  DocResult,
  McpAdapter,
  TicketResult,
} from '../adapter.interface.js';
import { atlassianFetch, redact, type AtlassianCreds } from './atlassian.http.js';

const logger = createLogger({ service: 'adapters.atlassian' });

const CAPS: readonly AdapterCapability[] = ['tickets', 'docs'];
const DEFAULT_LIMIT = 25;

export interface AtlassianAdapterOptions {
  readonly context: AdapterContext;
  readonly creds: AtlassianCreds;
  readonly fetchImpl?: typeof fetch;
}

export class AtlassianAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;

  private readonly creds: AtlassianCreds;
  private readonly fetchImpl: typeof fetch | undefined;
  private connected = false;

  constructor(opts: AtlassianAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl;
  }

  async connect(): Promise<void> {
    const ok = await this.healthCheck();
    if (!ok) throw new Error(`atlassian adapter ${this.id}: healthCheck failed`);
    this.connected = true;
    logger.info({ adapter: this.id, baseUrl: this.creds.baseUrl }, 'connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.call({ path: '/rest/api/3/myself' });
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      logger.warn(
        { adapter: this.id, error: redact(errMsg(err), this.creds.apiToken) },
        'healthCheck failed',
      );
      return false;
    }
  }

  async searchTickets(query: string): Promise<TicketResult[]> {
    const res = await this.call({
      path: '/rest/api/3/search',
      query: { jql: query, maxResults: DEFAULT_LIMIT },
    });
    if (res.status >= 400) {
      throw new Error(`atlassian searchTickets failed: status=${res.status}`);
    }
    return parseTickets(res.body);
  }

  async searchDocs(query: string): Promise<DocResult[]> {
    const res = await this.call({
      path: '/wiki/rest/api/content/search',
      query: { cql: query, limit: DEFAULT_LIMIT, expand: 'history,space' },
    });
    if (res.status >= 400) {
      throw new Error(`atlassian searchDocs failed: status=${res.status}`);
    }
    return parseDocs(res.body, this.creds.baseUrl);
  }

  private async call(req: {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  }) {
    const out = await atlassianFetch(this.creds, {
      ...req,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (out.status === 401 || out.status === 403) {
      throw new Error(`atlassian auth failed: status=${out.status}`);
    }
    return out;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

interface JiraIssue {
  readonly key?: unknown;
  readonly id?: unknown;
  readonly fields?: {
    readonly summary?: unknown;
    readonly status?: { readonly name?: unknown };
    readonly priority?: { readonly name?: unknown };
    readonly labels?: unknown;
  };
}

function parseTickets(body: unknown): TicketResult[] {
  const issues = (body as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return [];
  const out: TicketResult[] = [];
  for (const raw of issues) {
    const issue = raw as JiraIssue;
    const fields = issue.fields ?? {};
    const labels = Array.isArray(fields.labels) ? fields.labels : [];
    const firstLabel = labels.find((l): l is string => typeof l === 'string');
    out.push({
      id: String(issue.id ?? issue.key ?? ''),
      key: String(issue.key ?? ''),
      title: String(fields.summary ?? ''),
      status: String(fields.status?.name ?? 'unknown'),
      ...(fields.priority?.name !== undefined
        ? { priority: String(fields.priority.name) }
        : {}),
      ...(firstLabel !== undefined ? { service: firstLabel } : {}),
    });
  }
  return out;
}

interface ConfluenceResultRow {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly excerpt?: unknown;
  readonly _links?: { readonly webui?: unknown; readonly tinyui?: unknown };
}

function parseDocs(body: unknown, baseUrl: string): DocResult[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const trimmed = baseUrl.replace(/\/+$/, '');
  const out: DocResult[] = [];
  for (const raw of results) {
    const row = raw as ConfluenceResultRow;
    const webui = typeof row._links?.webui === 'string' ? row._links.webui : '';
    const url = webui ? `${trimmed}/wiki${webui.startsWith('/') ? '' : '/'}${webui}` : trimmed;
    out.push({
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      url,
      ...(typeof row.excerpt === 'string' && row.excerpt ? { snippet: row.excerpt } : {}),
      source: 'confluence',
    });
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
