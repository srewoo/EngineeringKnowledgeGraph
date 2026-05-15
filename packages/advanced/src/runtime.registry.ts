/**
 * Runtime provider registry — register / lookup by id or capability.
 *
 * Default state is empty. The MCP runtime-evidence tool surfaces a clean
 * "no providers configured" response when the registry is empty so the
 * agent can degrade gracefully.
 */

import type { RuntimeCapability, RuntimeSignalProvider } from './runtime.signal.interface.js';

export class RuntimeProviderRegistry {
  private readonly providers = new Map<string, RuntimeSignalProvider>();

  register(provider: RuntimeSignalProvider): void {
    if (!provider.id) throw new Error('RuntimeSignalProvider must have a non-empty id');
    if (this.providers.has(provider.id)) {
      throw new Error(`RuntimeSignalProvider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): RuntimeSignalProvider | undefined {
    return this.providers.get(id);
  }

  list(): readonly RuntimeSignalProvider[] {
    return [...this.providers.values()];
  }

  byCapability(cap: RuntimeCapability): readonly RuntimeSignalProvider[] {
    return this.list().filter((p) => p.capabilities.includes(cap));
  }

  size(): number {
    return this.providers.size;
  }
}
