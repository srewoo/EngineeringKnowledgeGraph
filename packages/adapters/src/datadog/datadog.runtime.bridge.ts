/**
 * Bridge from DatadogAdapter to the Phase 5 RuntimeSignalProvider seam.
 *
 * Lets the existing `runtime_evidence` MCP tool surface Datadog data the
 * moment a Datadog adapter is configured — no extra wiring at the agent.
 */

import type {
  RuntimeCapability,
  RuntimeEdgeEvidence,
  RuntimeHealth,
  RuntimeSignalProvider,
} from '@ekg/advanced';
import type { DatadogAdapter } from './datadog.adapter.js';

const RUNTIME_CAPS: readonly RuntimeCapability[] = ['traces', 'metrics', 'errors'];

const DEFAULT_WINDOW_MIN = 60;

export class DatadogRuntimeProvider implements RuntimeSignalProvider {
  readonly id: string;
  readonly capabilities = RUNTIME_CAPS;

  constructor(private readonly adapter: DatadogAdapter) {
    this.id = `${adapter.id}.runtime`;
  }

  async healthCheck(): Promise<boolean> {
    return this.adapter.healthCheck();
  }

  async getServiceHealth(service: string, timeRangeMin: number = DEFAULT_WINDOW_MIN): Promise<RuntimeHealth> {
    const range = makeRange(timeRangeMin);
    const metrics = await this.adapter.getServiceMetrics(service, range);
    const out: {
      service: string;
      sampleAt: string;
      errorRate?: number;
      p99LatencyMs?: number;
      rps?: number;
    } = { service, sampleAt: new Date().toISOString() };
    for (const m of metrics) {
      if (m.metric.endsWith('errors')) out.errorRate = m.value;
      else if (m.metric.endsWith('hits')) out.rps = m.value;
      else if (m.metric.endsWith('duration.p99')) out.p99LatencyMs = m.value;
    }
    return out;
  }

  async findRuntimeEvidence(
    serviceA: string,
    serviceB: string,
    _timeRangeMin: number = DEFAULT_WINDOW_MIN,
  ): Promise<RuntimeEdgeEvidence> {
    // Datadog cross-service traces require a more involved /api/v2/spans
    // aggregation. We expose a deterministic, conservative shape now and
    // let later passes fill in real call counts.
    return { serviceA, serviceB, observedCalls: 0, sample: [] };
  }
}

function makeRange(timeRangeMin: number): { fromIso: string; toIso: string } {
  const now = Date.now();
  return {
    fromIso: new Date(now - timeRangeMin * 60_000).toISOString(),
    toIso: new Date(now).toISOString(),
  };
}
