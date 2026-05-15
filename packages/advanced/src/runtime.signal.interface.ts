/**
 * Generic seam for runtime signal providers (Datadog, Loki, etc.).
 *
 * The agent layer (Phase 3) can ask "any runtime evidence corroborating a
 * graph claim?" without knowing which backend answers. Phase 6 will add real
 * adapters; Phase 5 only ships the interface plus a noop provider.
 */

export type RuntimeCapability = 'traces' | 'metrics' | 'logs' | 'errors' | 'usage';

export interface RuntimeHealth {
  readonly service: string;
  readonly errorRate?: number;
  readonly p99LatencyMs?: number;
  readonly rps?: number;
  readonly sampleAt: string;
}

export interface RuntimeEdgeEvidence {
  readonly serviceA: string;
  readonly serviceB: string;
  readonly observedCalls: number;
  readonly sample: ReadonlyArray<{ readonly traceId?: string; readonly durationMs?: number }>;
}

export interface RuntimeSignalProvider {
  readonly id: string;
  readonly capabilities: readonly RuntimeCapability[];
  healthCheck(): Promise<boolean>;
  getServiceHealth?(service: string, timeRangeMin?: number): Promise<RuntimeHealth>;
  findRuntimeEvidence?(
    serviceA: string,
    serviceB: string,
    timeRangeMin?: number,
  ): Promise<RuntimeEdgeEvidence>;
}
