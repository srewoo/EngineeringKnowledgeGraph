import { describe, it, expect, vi } from 'vitest';
import { DatadogAdapter } from '../../../src/datadog/datadog.adapter.js';

interface FakeCall { url: string; init: RequestInit | undefined }

function makeFetch(handler: (call: FakeCall) => { status: number; body: unknown }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const out = handler({ url: String(url), init });
    return new Response(JSON.stringify(out.body ?? ''), { status: out.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function makeAdapter(fetchImpl: typeof fetch): DatadogAdapter {
  return new DatadogAdapter({
    context: { id: 'datadog', env: {}, config: {} },
    creds: { apiKey: 'key123', appKey: 'app123', site: 'datadoghq.com' },
    fetchImpl,
  });
}

describe('DatadogAdapter', () => {
  it('healthCheck calls /api/v1/validate with API + APP keys', async () => {
    const calls: FakeCall[] = [];
    const adapter = makeAdapter(makeFetch((c) => {
      calls.push(c);
      return { status: 200, body: { valid: true } };
    }));
    expect(await adapter.healthCheck()).toBe(true);
    expect(calls[0]?.url).toContain('/api/v1/validate');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['DD-API-KEY']).toBe('key123');
    expect(headers['DD-APPLICATION-KEY']).toBe('app123');
  });

  it('connect throws when validate fails', async () => {
    const adapter = makeAdapter(makeFetch(() => ({ status: 500, body: {} })));
    await expect(adapter.connect()).rejects.toThrow();
  });

  it('retries on 429 then succeeds', async () => {
    let n = 0;
    const adapter = makeAdapter(makeFetch(() => {
      n += 1;
      if (n === 1) return { status: 429, body: { error: 'rate' } };
      return { status: 200, body: {} };
    }));
    expect(await adapter.healthCheck()).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('does not retry on 401 — surfaces auth error', async () => {
    let n = 0;
    const adapter = makeAdapter(makeFetch(() => {
      n += 1;
      return { status: 401, body: { error: 'unauthorized' } };
    }));
    expect(await adapter.healthCheck()).toBe(false);
    expect(n).toBe(1);
  });

  it('getServiceMetrics POSTs the timeseries query and parses series', async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch((c) => {
      calls.push(c);
      if (String(c.url).includes('/validate')) return { status: 200, body: {} };
      return {
        status: 200,
        body: {
          data: {
            attributes: {
              series: [{ metric: 'errors' }, { metric: 'hits' }, { metric: 'duration.p99' }],
              values: [[1, 2], [10, 11], [100, 200]],
              times: [1700000000000, 1700000060000],
            },
          },
        },
      };
    });
    const adapter = makeAdapter(fetchImpl);
    const metrics = await adapter.getServiceMetrics('person-service', {
      fromIso: '2025-01-01T00:00:00Z',
      toIso: '2025-01-01T01:00:00Z',
    });
    expect(metrics).toHaveLength(3);
    expect(metrics[0]?.value).toBe(2);
    expect(metrics[2]?.value).toBe(200);
    const last = calls.at(-1);
    expect(last?.init?.method).toBe('POST');
    expect(String(last?.url)).toContain('/api/v2/query/timeseries');
    const body = JSON.parse(String(last?.init?.body ?? '{}'));
    expect(body.data.attributes.queries[0].query).toContain('person-service');
  });

  it('aborts hanging fetch via AbortController', async () => {
    const { datadogFetch } = await import('../../../src/datadog/datadog.http.js');
    let aborted = false;
    const hangFetch: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    await expect(
      datadogFetch(
        { apiKey: 'k', appKey: 'a', site: 'datadoghq.com' },
        { path: '/api/v1/validate', timeoutMs: 20, fetchImpl: hangFetch },
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    void vi;
  });
});
