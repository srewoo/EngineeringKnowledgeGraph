import { describe, it, expect } from 'vitest';
import { AtlassianAdapter } from '../../../src/atlassian/atlassian.adapter.js';
import { redact } from '../../../src/atlassian/atlassian.http.js';

interface FakeCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  handler: (call: FakeCall) => { status: number; body: unknown },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const out = handler({ url: String(url), init });
    return new Response(JSON.stringify(out.body ?? ''), {
      status: out.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function makeAdapter(fetchImpl: typeof fetch): AtlassianAdapter {
  return new AtlassianAdapter({
    context: { id: 'atlassian', env: {}, config: {} },
    creds: {
      baseUrl: 'https://example.atlassian.net',
      email: 'user@example.com',
      apiToken: 'tok-secret-123456789012345',
    },
    fetchImpl,
  });
}

describe('AtlassianAdapter', () => {
  it('healthCheck calls /rest/api/3/myself with Basic auth header', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return { status: 200, body: { accountId: 'x' } };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    expect(calls[0]?.url).toContain('/rest/api/3/myself');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    const decoded = Buffer.from(
      headers.Authorization.replace(/^Basic /, ''),
      'base64',
    ).toString('utf8');
    expect(decoded).toBe('user@example.com:tok-secret-123456789012345');
  });

  it('searchTickets passes JQL through and parses issues', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        if (c.url.includes('/myself')) return { status: 200, body: {} };
        return {
          status: 200,
          body: {
            issues: [
              {
                id: '10001',
                key: 'PERSON-42',
                fields: {
                  summary: 'Bug in login',
                  status: { name: 'Open' },
                  priority: { name: 'P1' },
                  labels: ['person-service', 'auth'],
                },
              },
            ],
          },
        };
      }),
    );
    const tickets = await adapter.searchTickets('project = PERSON AND status = Open');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      key: 'PERSON-42',
      title: 'Bug in login',
      status: 'Open',
      priority: 'P1',
      service: 'person-service',
    });
    const last = calls.at(-1);
    expect(last?.url).toContain('/rest/api/3/search');
    expect(last?.url).toContain('jql=');
    expect(last?.url).toContain('maxResults=25');
  });

  it('searchDocs passes CQL through and builds Confluence URL', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return {
          status: 200,
          body: {
            results: [
              {
                id: 'page-1',
                title: 'Coaching ADR',
                excerpt: 'design notes',
                _links: { webui: '/spaces/ENG/pages/123/Coaching' },
              },
            ],
          },
        };
      }),
    );
    const docs = await adapter.searchDocs('text ~ "coaching"');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.url).toBe(
      'https://example.atlassian.net/wiki/spaces/ENG/pages/123/Coaching',
    );
    expect(docs[0]?.source).toBe('confluence');
    expect(docs[0]?.snippet).toBe('design notes');
    const last = calls.at(-1);
    expect(last?.url).toContain('/wiki/rest/api/content/search');
    expect(last?.url).toContain('cql=');
  });

  it('retries on 429 then succeeds', async () => {
    let n = 0;
    const adapter = makeAdapter(
      makeFetch(() => {
        n += 1;
        if (n === 1) return { status: 429, body: { error: 'rate' } };
        return { status: 200, body: {} };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('does not retry on 401 — surfaces auth error', async () => {
    let n = 0;
    const adapter = makeAdapter(
      makeFetch(() => {
        n += 1;
        return { status: 401, body: { error: 'unauthorized' } };
      }),
    );
    expect(await adapter.healthCheck()).toBe(false);
    expect(n).toBe(1);
  });

  it('redact() strips API tokens and Basic blobs from log strings', () => {
    const out = redact(
      'Authorization: Basic dXNlckBleGFtcGxlLmNvbTp0b2stc2VjcmV0LTEyMzQ1Njc4OTAxMjM0NQ== leaked tok-secret-123456789012345',
      'tok-secret-123456789012345',
    );
    expect(out).not.toContain('tok-secret-123456789012345');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
  });
});
