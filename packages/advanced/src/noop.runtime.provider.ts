/**
 * No-op RuntimeSignalProvider — returns "no signal" cleanly.
 *
 * Used as a default when nothing is configured so callers don't have to
 * special-case an empty registry.
 */

import type {
  RuntimeCapability,
  RuntimeEdgeEvidence,
  RuntimeHealth,
  RuntimeSignalProvider,
} from './runtime.signal.interface.js';

export class NoopRuntimeProvider implements RuntimeSignalProvider {
  readonly id = 'noop';
  readonly capabilities: readonly RuntimeCapability[] = [];

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async getServiceHealth(service: string): Promise<RuntimeHealth> {
    return { service, sampleAt: new Date().toISOString() };
  }

  async findRuntimeEvidence(serviceA: string, serviceB: string): Promise<RuntimeEdgeEvidence> {
    return { serviceA, serviceB, observedCalls: 0, sample: [] };
  }
}
