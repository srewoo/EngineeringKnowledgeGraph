/**
 * bootstrapAdapters — wires config → factories → registry.
 *
 * Errors during adapter `connect()` mark the adapter unhealthy in the
 * registry but never crash bootstrap. Adapter ids in config that have no
 * matching factory log a `warn` and are skipped — this keeps stub config
 * entries (atlassian, mixpanel, loki) from breaking startup.
 */

import { createLogger } from '@ekg/shared';
import { RuntimeProviderRegistry } from '@ekg/advanced';
import type { AdapterContext, McpAdapter } from './adapter.interface.js';
import { AdapterRegistry } from './adapter.registry.js';
import { loadAdapterConfig, expandEnvRefs, type AdapterConfig } from './adapter.config.js';
import { createDatadogAdapter } from './datadog/datadog.factory.js';
import { DatadogAdapter } from './datadog/datadog.adapter.js';
import { DatadogRuntimeProvider } from './datadog/datadog.runtime.bridge.js';

const logger = createLogger({ service: 'adapters.bootstrap' });

export type AdapterFactory = (ctx: AdapterContext) => McpAdapter;

const DEFAULT_FACTORIES: Readonly<Record<string, AdapterFactory>> = {
  datadog: (ctx) => createDatadogAdapter(ctx),
};

export interface BootstrapOptions {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, AdapterFactory>>;
  readonly runtimeRegistry?: RuntimeProviderRegistry;
  /** Provided configs override file-based loading (used by tests). */
  readonly configs?: readonly AdapterConfig[];
}

export interface BootstrapResult {
  readonly registry: AdapterRegistry;
  readonly runtimeRegistry: RuntimeProviderRegistry;
}

export async function bootstrapAdapters(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const registry = new AdapterRegistry();
  const runtimeRegistry = opts.runtimeRegistry ?? new RuntimeProviderRegistry();
  const factories = opts.factories ?? DEFAULT_FACTORIES;
  const env = opts.env ?? process.env;

  const configs = opts.configs ?? (opts.configPath ? loadAdapterConfig(opts.configPath) : []);

  for (const cfg of configs) {
    if (!cfg.enabled) {
      logger.info({ adapter: cfg.id }, 'adapter disabled, skipping');
      continue;
    }
    const factory = factories[cfg.id];
    if (!factory) {
      logger.warn({ adapter: cfg.id }, 'adapter declared but no factory implemented');
      continue;
    }
    const ctx: AdapterContext = {
      id: cfg.id,
      env: expandEnvRefs(cfg.env, env, { adapterId: cfg.id, enabled: true }),
      config: cfg.config ?? {},
    };
    let adapter: McpAdapter;
    try {
      adapter = factory(ctx);
    } catch (err) {
      logger.warn({ adapter: cfg.id, error: errMsg(err) }, 'adapter factory failed');
      continue;
    }
    registry.register(adapter, { priority: cfg.priority, healthy: true });
    try {
      await adapter.connect();
    } catch (err) {
      logger.warn({ adapter: cfg.id, error: errMsg(err) }, 'adapter connect failed; marking unhealthy');
      registry.setHealthy(cfg.id, false);
      continue;
    }
    // Phase 5 bridge — wire Datadog into the existing runtime registry.
    if (adapter instanceof DatadogAdapter) {
      const provider = new DatadogRuntimeProvider(adapter);
      try {
        runtimeRegistry.register(provider);
      } catch (err) {
        logger.warn({ adapter: cfg.id, error: errMsg(err) }, 'runtime provider registration failed');
      }
    }
  }
  return { registry, runtimeRegistry };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
