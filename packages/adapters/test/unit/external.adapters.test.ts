import { describe, it, expect, vi } from 'vitest';
import { AtlassianAdapter } from '../../src/atlassian/atlassian.adapter.js';
import { MixpanelAdapter } from '../../src/mixpanel/mixpanel.adapter.js';
import { LokiAdapter } from '../../src/loki/loki.adapter.js';
import type { AdapterContext } from '../../src/adapter.interface.js';
import { McpStdioClient } from '../../src/mcp.client.js';

const ctx: AdapterContext = { id: 'x', env: {}, config: {} };

function stubClient(payload: unknown): McpStdioClient {
  // Minimal fake — extend the real class so instanceof checks (none in code,
  // but defensive) still work, and override the methods we exercise.
  const fake = Object.create(McpStdioClient.prototype) as McpStdioClient;
  Object.assign(fake, {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      raw: payload,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    }),
  });
  return fake;
}

describe('AtlassianAdapter', () => {
  it('normalises Confluence search results to DocResult[]', async () => {
    const adapter = new AtlassianAdapter({ context: ctx, command: 'noop' });
    (adapter as unknown as { client: McpStdioClient }).client = stubClient({
      results: [
        { id: 'p1', title: 'Auth ADR', url: 'https://wiki/x/p1', excerpt: 'why' },
        { pageId: 'p2', summary: 'Runbook', _links: { webui: '/p2' } },
      ],
    });
    const docs = await adapter.searchDocs('auth');
    expect(docs).toHaveLength(2);
    expect(docs[0]!.title).toBe('Auth ADR');
    expect(docs[0]!.snippet).toBe('why');
    expect(docs[1]!.id).toBe('p2');
  });

  it('normalises Jira issues to TicketResult[]', async () => {
    const adapter = new AtlassianAdapter({ context: ctx, command: 'noop' });
    (adapter as unknown as { client: McpStdioClient }).client = stubClient({
      issues: [
        { key: 'PROJ-1', summary: 'Bug A', status: 'Open', priority: 'P1' },
        { id: '99', title: 'Bug B', statusName: 'Done' },
      ],
    });
    const tix = await adapter.searchTickets('proj');
    expect(tix).toHaveLength(2);
    expect(tix[0]!.key).toBe('PROJ-1');
    expect(tix[0]!.status).toBe('Open');
    expect(tix[1]!.status).toBe('Done');
  });
});

describe('MixpanelAdapter', () => {
  it('normalises an array result into UsageResult[]', async () => {
    const adapter = new MixpanelAdapter({ context: ctx, command: 'noop' });
    (adapter as unknown as { client: McpStdioClient }).client = stubClient({
      data: [
        { event: 'page_view', count: 1234, uniqueUsers: 567 },
        { event: 'login', count: 42, unique: 30 },
      ],
    });
    const out = await adapter.getUsage('page_view', {
      fromIso: '2026-05-10T00:00:00Z',
      toIso: '2026-05-17T00:00:00Z',
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.eventCount).toBe(1234);
    expect(out[1]!.uniqueUsers).toBe(30);
  });

  it('falls back to a single summary when payload is a flat object', async () => {
    const adapter = new MixpanelAdapter({ context: ctx, command: 'noop' });
    (adapter as unknown as { client: McpStdioClient }).client = stubClient({
      event: 'login',
      total: 99,
      unique: 50,
    });
    const out = await adapter.getUsage('login', {
      fromIso: '2026-05-10T00:00:00Z',
      toIso: '2026-05-17T00:00:00Z',
    });
    expect(out).toEqual([
      {
        event: 'login',
        eventCount: 99,
        uniqueUsers: 50,
        window: '2026-05-10T00:00:00Z/2026-05-17T00:00:00Z',
      },
    ]);
  });
});

describe('LokiAdapter', () => {
  it('normalises Loki streams payload to LogResult[]', async () => {
    const adapter = new LokiAdapter({ context: ctx, command: 'noop' });
    (adapter as unknown as { client: McpStdioClient }).client = stubClient({
      streams: [
        { service: 'orders', message: 'boom', level: 'error', timestamp: '2026-05-17T10:00:00Z' },
        { app: 'users', line: 'ok', severity: 'info', ts: '2026-05-17T10:01:00Z' },
      ],
    });
    const logs = await adapter.getLogs('{app="orders"}', {
      fromIso: '2026-05-17T09:00:00Z',
      toIso: '2026-05-17T11:00:00Z',
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]!.service).toBe('orders');
    expect(logs[0]!.level).toBe('error');
    expect(logs[1]!.service).toBe('users');
    expect(logs[1]!.message).toBe('ok');
  });
});
