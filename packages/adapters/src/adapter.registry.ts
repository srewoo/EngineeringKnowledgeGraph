/**
 * AdapterRegistry — owns the lifecycle and lookup of registered McpAdapters.
 *
 * Tracks a per-adapter health snapshot so the router and `list_adapters`
 * tool can surface degraded adapters without re-probing on every call.
 */

import { createLogger } from '@ekg/shared';
import type { AdapterCapability, McpAdapter } from './adapter.interface.js';

const logger = createLogger({ service: 'adapters.registry' });

interface Entry {
  readonly adapter: McpAdapter;
  readonly priority: number;
  healthy: boolean;
}

export class AdapterRegistry {
  private readonly entries = new Map<string, Entry>();

  register(adapter: McpAdapter, opts: { priority?: number; healthy?: boolean } = {}): void {
    if (!adapter.id) throw new Error('McpAdapter must have a non-empty id');
    if (this.entries.has(adapter.id)) {
      throw new Error(`McpAdapter already registered: ${adapter.id}`);
    }
    this.entries.set(adapter.id, {
      adapter,
      priority: opts.priority ?? 0,
      healthy: opts.healthy ?? true,
    });
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  getById(id: string): McpAdapter | undefined {
    return this.entries.get(id)?.adapter;
  }

  /** Adapters supporting a capability, sorted by priority desc (stable). */
  getByCapability(cap: AdapterCapability): readonly McpAdapter[] {
    const matched = [...this.entries.values()]
      .filter((e) => e.healthy && e.adapter.capabilities.includes(cap))
      .sort((a, b) => b.priority - a.priority);
    return matched.map((e) => e.adapter);
  }

  listEnabled(): readonly McpAdapter[] {
    return [...this.entries.values()].filter((e) => e.healthy).map((e) => e.adapter);
  }

  listAll(): ReadonlyArray<{ readonly adapter: McpAdapter; readonly healthy: boolean; readonly priority: number }> {
    return [...this.entries.values()].map((e) => ({
      adapter: e.adapter,
      healthy: e.healthy,
      priority: e.priority,
    }));
  }

  setHealthy(id: string, healthy: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.healthy = healthy;
  }

  size(): number {
    return this.entries.size;
  }

  async healthCheckAll(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const entry of this.entries.values()) {
      try {
        const ok = await entry.adapter.healthCheck();
        entry.healthy = ok;
        result[entry.adapter.id] = ok;
      } catch (err) {
        entry.healthy = false;
        result[entry.adapter.id] = false;
        logger.warn(
          { adapter: entry.adapter.id, error: errMsg(err) },
          'healthCheck threw',
        );
      }
    }
    return result;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
