import { describe, it, expect } from 'vitest';
import { MixpanelAdapter } from '../../../src/mixpanel/mixpanel.adapter.js';
import { redact } from '../../../src/mixpanel/mixpanel.http.js';

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

function makeAdapter(fetchImpl: typeof fetch): MixpanelAdapter {
  return new MixpanelAdapter({
    context: { id: 'mixpanel', env: {}, config: {} },
    creds: {
      projectId: '111',
      serviceAccount: 'svc-user:svc-secret-12345678901234567890',
    },
    fetchImpl,
  });
}

describe('MixpanelAdapter', () => {
  it('healthCheck calls events/names with project_id and Basic auth', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        calls.push(c);
        return { status: 200, body: ['Login', 'Signup'] };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    const url = calls[0]?.url ?? '';
    expect(url).toContain('mixpanel.com/api/2.0/events/names');
    expect(url).toContain('project_id=111');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    const decoded = Buffer.from(
      headers.Authorization.replace(/^Basic /, ''),
      'base64',
    ).toString('utf8');
    expect(decoded).toBe('svc-user:svc-secret-12345678901234567890');
  });

  it('getUsage decomposes into per-day UsageResults via parallel general+unique', async () => {
    const seen: string[] = [];
    const adapter = makeAdapter(
      makeFetch((c) => {
        seen.push(c.url);
        if (c.url.includes('type=general')) {
          return {
            status: 200,
            body: {
              data: {
                values: {
                  'login.success': {
                    '2025-03-01': 100,
                    '2025-03-02': 150,
                  },
                },
              },
            },
          };
        }
        if (c.url.includes('type=unique')) {
          return {
            status: 200,
            body: {
              data: {
                values: {
                  'login.success': {
                    '2025-03-01': 40,
                    '2025-03-02': 55,
                  },
                },
              },
            },
          };
        }
        return { status: 200, body: {} };
      }),
    );
    const result = await adapter.getUsage('login.success', {
      fromIso: '2025-03-01T00:00:00Z',
      toIso: '2025-03-02T23:59:59Z',
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      event: 'login.success',
      eventCount: 100,
      uniqueUsers: 40,
      window: '2025-03-01',
    });
    expect(result[1]).toMatchObject({
      eventCount: 150,
      uniqueUsers: 55,
      window: '2025-03-02',
    });
    // Two segmentation calls, both with from/to dates.
    const segCalls = seen.filter((u) => u.includes('segmentation'));
    expect(segCalls).toHaveLength(2);
    for (const u of segCalls) {
      expect(u).toContain('from_date=2025-03-01');
      expect(u).toContain('to_date=2025-03-02');
      expect(u).toContain('event=login.success');
    }
  });

  it('retries on 503 then succeeds', async () => {
    let n = 0;
    const adapter = makeAdapter(
      makeFetch(() => {
        n += 1;
        if (n === 1) return { status: 503, body: {} };
        return { status: 200, body: [] };
      }),
    );
    expect(await adapter.healthCheck()).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('does not retry on 401', async () => {
    let n = 0;
    const adapter = makeAdapter(
      makeFetch(() => {
        n += 1;
        return { status: 401, body: {} };
      }),
    );
    expect(await adapter.healthCheck()).toBe(false);
    expect(n).toBe(1);
  });

  it('redact() removes service-account secret and Basic blobs', () => {
    const creds = {
      projectId: '1',
      serviceAccount: 'svc-user:svc-secret-12345678901234567890',
    };
    const out = redact(
      'svc-secret-12345678901234567890 leaked; Authorization: Basic c3ZjLXVzZXI6c3ZjLXNlY3JldA==',
      creds,
    );
    expect(out).not.toContain('svc-secret-12345678901234567890');
    expect(out).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
    expect(out).toContain('[REDACTED]');
  });
});
