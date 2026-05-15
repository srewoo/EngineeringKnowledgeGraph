import { describe, it, expect } from 'vitest';
import { LokiAdapter } from '../../../src/loki/loki.adapter.js';
import { redact } from '../../../src/loki/loki.http.js';

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

function makeAdapter(
  fetchImpl: typeof fetch,
  creds: Partial<ConstructorParameters<typeof LokiAdapter>[0]['creds']> = {},
): LokiAdapter {
  return new LokiAdapter({
    context: { id: 'loki', env: {}, config: {} },
    creds: {
      baseUrl: 'https://logs.example.com',
      ...creds,
    },
    fetchImpl,
  });
}

describe('LokiAdapter', () => {
  it('healthCheck hits /ready', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return { status: 200, body: 'ready' };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    expect(calls[0]?.url).toContain('/ready');
  });

  it('sends optional Bearer + X-Scope-OrgID when configured', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return { status: 200, body: 'ready' };
      }),
      { tenantId: 'tenant-a', token: 'tok-abcdefghij1234567890' },
    );
    await adapter.healthCheck();
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abcdefghij1234567890');
    expect(headers['X-Scope-OrgID']).toBe('tenant-a');
  });

  it('omits Authorization when no token configured', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return { status: 200, body: 'ready' };
      }),
    );
    await adapter.healthCheck();
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Scope-OrgID']).toBeUndefined();
  });

  it('getLogs passes LogQL through and converts ms→ns for start/end', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return {
          status: 200,
          body: {
            data: {
              result: [
                {
                  stream: { service_name: 'person', level: 'info' },
                  values: [
                    ['1700000000000000000', 'hello'],
                    ['1700000001000000000', 'world'],
                  ],
                },
              ],
            },
          },
        };
      }),
    );
    const fromIso = '2025-01-01T00:00:00.000Z';
    const toIso = '2025-01-01T01:00:00.000Z';
    const logs = await adapter.getLogs('{service_name="person"}', { fromIso, toIso });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ service: 'person', message: 'hello', level: 'info' });
    const url = calls[0]?.url ?? '';
    expect(url).toContain('/loki/api/v1/query_range');
    expect(decodeURIComponent(url)).toContain('query={service_name="person"}');
    const startMs = Date.parse(fromIso);
    const endMs = Date.parse(toIso);
    expect(url).toContain(`start=${startMs}000000`);
    expect(url).toContain(`end=${endMs}000000`);
    expect(url).toContain('limit=500');
  });

  it('getErrors aggregates by message and tags with service', async () => {
    const adapter = makeAdapter(
      makeFetch(() => ({
        status: 200,
        body: {
          data: {
            result: [
              {
                stream: { service_name: 'person', level: 'error' },
                values: [
                  ['1700000000000000000', 'NPE at line 5'],
                  ['1700000001000000000', 'NPE at line 5'],
                  ['1700000002000000000', 'connection refused'],
                ],
              },
            ],
          },
        },
      })),
    );
    const errors = await adapter.getErrors('person', {
      fromIso: '2025-01-01T00:00:00Z',
      toIso: '2025-01-01T01:00:00Z',
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      service: 'person',
      message: 'NPE at line 5',
      count: 2,
    });
    expect(errors[1]?.message).toBe('connection refused');
  });

  it('retries on 502 then succeeds', async () => {
    let n = 0;
    const adapter = makeAdapter(
      makeFetch(() => {
        n += 1;
        if (n === 1) return { status: 502, body: {} };
        return { status: 200, body: 'ready' };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('redact() removes Bearer tokens', () => {
    const out = redact(
      'failure with Authorization: Bearer tok-abcdefghij1234567890',
      'tok-abcdefghij1234567890',
    );
    expect(out).not.toContain('tok-abcdefghij1234567890');
    expect(out).toContain('[REDACTED]');
  });
});
