/**
 * CapabilityRouter — fan-out across all adapters supporting a capability.
 *
 * Per-adapter timeout (`EKG_ADAPTER_TIMEOUT_MS`, default 5000). Failures and
 * timeouts are logged at warn and **never re-thrown**: degraded adapters
 * must never break the agent's request path.
 */

import { createLogger } from '@ekg/shared';
import type { AdapterCapability, McpAdapter } from './adapter.interface.js';
import type { AdapterRegistry } from './adapter.registry.js';

const logger = createLogger({ service: 'adapters.router' });

const DEFAULT_TIMEOUT_MS = 5_000;

export interface RouterOptions {
  readonly timeoutMs?: number;
}

export interface RoutedResult<T> {
  readonly adapterId: string;
  readonly result: T;
}

export class CapabilityRouter {
  private readonly timeoutMs: number;

  constructor(
    private readonly registry: AdapterRegistry,
    opts: RouterOptions = {},
  ) {
    const envVal = Number(process.env['EKG_ADAPTER_TIMEOUT_MS']);
    this.timeoutMs = opts.timeoutMs ?? (Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_TIMEOUT_MS);
  }

  hasCapability(cap: AdapterCapability): boolean {
    return this.registry.getByCapability(cap).length > 0;
  }

  /**
   * Fans out `fn` to every adapter for `cap` (priority order). Returns
   * non-failing results; adapters that error or time out are skipped.
   */
  async route<T>(
    cap: AdapterCapability,
    fn: (adapter: McpAdapter) => Promise<T> | undefined,
  ): Promise<ReadonlyArray<RoutedResult<T>>> {
    const adapters = this.registry.getByCapability(cap);
    if (adapters.length === 0) return [];

    const results: Array<RoutedResult<T>> = [];
    for (const adapter of adapters) {
      const out = await this.runOne(adapter, fn);
      if (out !== undefined) results.push({ adapterId: adapter.id, result: out });
    }
    return results;
  }

  private async runOne<T>(
    adapter: McpAdapter,
    fn: (adapter: McpAdapter) => Promise<T> | undefined,
  ): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ adapter: adapter.id, timeoutMs: this.timeoutMs }, 'adapter call timed out');
        resolve(undefined);
      }, this.timeoutMs);
    });
    try {
      const invocation = fn(adapter);
      if (invocation === undefined) return undefined;
      const winner = await Promise.race([invocation, timeout]);
      return winner;
    } catch (err) {
      logger.warn({ adapter: adapter.id, error: errMsg(err) }, 'adapter call failed');
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
