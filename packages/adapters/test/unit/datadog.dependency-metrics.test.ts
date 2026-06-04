/**
 * Tests for the spans-analytics aggregate response parser used by
 * `DatadogAdapter.getServiceDependencyMetrics`. The HTTP call is mocked at
 * the adapter boundary in higher-level tests; here we just verify the
 * pure parser against canned Datadog payload shapes.
 */

import { describe, it, expect } from 'vitest';
import { parseServiceDependencyMetrics } from '../../src/datadog/datadog.adapter.js';

describe('parseServiceDependencyMetrics', () => {
  it('returns [] for missing or malformed envelopes', () => {
    expect(parseServiceDependencyMetrics(null)).toEqual([]);
    expect(parseServiceDependencyMetrics(undefined)).toEqual([]);
    expect(parseServiceDependencyMetrics({})).toEqual([]);
    expect(parseServiceDependencyMetrics({ data: { attributes: {} } })).toEqual([]);
  });

  it('parses normal aggregate buckets into enriched edges', () => {
    const body = {
      data: {
        attributes: {
          buckets: [
            {
              by: [{ value: 'payment-service' }, { value: 'gateway' }],
              computes: { c0: 1234, c1: 250_000_000 }, // 250ms in ns
            },
            {
              by: [{ value: 'billing' }, { value: 'gateway' }],
              computes: { c0: 56, c1: 80_000_000 }, // 80ms
            },
          ],
        },
      },
    };
    const edges = parseServiceDependencyMetrics(body);
    expect(edges).toHaveLength(2);
    const first = edges[0]!;
    // Caller is the second `by` (parent_service), callee the first.
    expect(first.caller).toBe('gateway');
    expect(first.callee).toBe('payment-service');
    expect(first.callCount).toBe(1234);
    expect(first.p99LatencyMs).toBe(250);
  });

  it('drops self-loops and rows with missing facets', () => {
    const body = {
      data: {
        attributes: {
          buckets: [
            { by: [{ value: 'gateway' }, { value: 'gateway' }], computes: { c0: 10 } }, // self
            { by: [{ value: '' }, { value: 'foo' }], computes: { c0: 10 } },             // empty callee
            { by: [{ value: 'foo' }], computes: { c0: 10 } },                            // truncated `by`
            { by: [{ value: 'foo' }, { value: 'bar' }], computes: { c0: 5 } },           // valid
          ],
        },
      },
    };
    const edges = parseServiceDependencyMetrics(body);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ caller: 'bar', callee: 'foo', callCount: 5 });
  });

  it('tolerates missing p99 — count alone is enough', () => {
    const body = {
      data: {
        attributes: {
          buckets: [
            { by: [{ value: 'a' }, { value: 'b' }], computes: { c0: 7 } },
          ],
        },
      },
    };
    const edges = parseServiceDependencyMetrics(body);
    expect(edges[0]).toEqual({ caller: 'b', callee: 'a', callCount: 7 });
  });

  it('parses string-encoded numeric computes', () => {
    const body = {
      data: {
        attributes: {
          buckets: [
            { by: [{ value: 'a' }, { value: 'b' }], computes: { c0: '99', c1: '1000000' } },
          ],
        },
      },
    };
    const edges = parseServiceDependencyMetrics(body);
    expect(edges[0]).toMatchObject({ callCount: 99, p99LatencyMs: 1 });
  });
});
