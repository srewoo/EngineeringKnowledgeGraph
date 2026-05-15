import { describe, it, expect } from 'vitest';
import { DatadogRuntimeProvider } from '../../../src/datadog/datadog.runtime.bridge.js';
import type { DatadogAdapter } from '../../../src/datadog/datadog.adapter.js';
import type { MetricResult, TimeRange } from '../../../src/adapter.interface.js';

function fakeAdapter(metrics: MetricResult[]): DatadogAdapter {
  return {
    id: 'datadog',
    capabilities: ['metrics', 'traces', 'errors', 'alarms'],
    context: { id: 'datadog', env: {}, config: {} },
    async connect() {},
    async disconnect() {},
    async healthCheck() { return true; },
    async getServiceMetrics(_s: string, _t: TimeRange) { return metrics; },
  } as unknown as DatadogAdapter;
}

describe('DatadogRuntimeProvider', () => {
  it('exposes runtime capabilities', () => {
    const p = new DatadogRuntimeProvider(fakeAdapter([]));
    expect(p.capabilities).toEqual(['traces', 'metrics', 'errors']);
    expect(p.id).toBe('datadog.runtime');
  });

  it('maps Datadog metrics to RuntimeHealth fields', async () => {
    const metrics: MetricResult[] = [
      { service: 's', metric: 'trace.s.errors', value: 0.02, sampleAt: 'now' },
      { service: 's', metric: 'trace.s.hits', value: 350, sampleAt: 'now' },
      { service: 's', metric: 'trace.s.duration.p99', value: 180, sampleAt: 'now' },
    ];
    const p = new DatadogRuntimeProvider(fakeAdapter(metrics));
    const health = await p.getServiceHealth('s', 30);
    expect(health.service).toBe('s');
    expect(health.errorRate).toBe(0.02);
    expect(health.rps).toBe(350);
    expect(health.p99LatencyMs).toBe(180);
  });

  it('returns conservative empty edge evidence', async () => {
    const p = new DatadogRuntimeProvider(fakeAdapter([]));
    const e = await p.findRuntimeEvidence('a', 'b');
    expect(e).toEqual({ serviceA: 'a', serviceB: 'b', observedCalls: 0, sample: [] });
  });
});
