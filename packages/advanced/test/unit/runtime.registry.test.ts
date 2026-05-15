import { describe, it, expect } from 'vitest';
import { RuntimeProviderRegistry } from '../../src/runtime.registry.js';
import { NoopRuntimeProvider } from '../../src/noop.runtime.provider.js';
import type { RuntimeSignalProvider } from '../../src/runtime.signal.interface.js';

function makeProvider(id: string, caps: RuntimeSignalProvider['capabilities']): RuntimeSignalProvider {
  return {
    id,
    capabilities: caps,
    async healthCheck() { return true; },
  };
}

describe('RuntimeProviderRegistry', () => {
  it('starts empty', () => {
    const reg = new RuntimeProviderRegistry();
    expect(reg.size()).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('registers and retrieves by id', () => {
    const reg = new RuntimeProviderRegistry();
    const p = makeProvider('dd', ['traces', 'errors']);
    reg.register(p);
    expect(reg.get('dd')).toBe(p);
    expect(reg.size()).toBe(1);
  });

  it('rejects empty id', () => {
    const reg = new RuntimeProviderRegistry();
    expect(() => reg.register(makeProvider('', ['logs']))).toThrow();
  });

  it('rejects duplicate id', () => {
    const reg = new RuntimeProviderRegistry();
    reg.register(makeProvider('dd', ['traces']));
    expect(() => reg.register(makeProvider('dd', ['logs']))).toThrow();
  });

  it('filters by capability', () => {
    const reg = new RuntimeProviderRegistry();
    reg.register(makeProvider('dd', ['traces', 'errors']));
    reg.register(makeProvider('loki', ['logs', 'errors']));
    reg.register(makeProvider('mx', ['usage']));
    expect(reg.byCapability('errors').map((p) => p.id).sort()).toEqual(['dd', 'loki']);
    expect(reg.byCapability('usage').map((p) => p.id)).toEqual(['mx']);
    expect(reg.byCapability('metrics')).toEqual([]);
  });

  it('unregister removes entry', () => {
    const reg = new RuntimeProviderRegistry();
    reg.register(makeProvider('dd', ['traces']));
    expect(reg.unregister('dd')).toBe(true);
    expect(reg.unregister('dd')).toBe(false);
    expect(reg.size()).toBe(0);
  });
});

describe('NoopRuntimeProvider', () => {
  it('reports zero capabilities and healthy', async () => {
    const noop = new NoopRuntimeProvider();
    expect(noop.capabilities).toEqual([]);
    expect(await noop.healthCheck()).toBe(true);
  });

  it('returns empty health and zero observed calls', async () => {
    const noop = new NoopRuntimeProvider();
    const h = await noop.getServiceHealth('any');
    expect(h.service).toBe('any');
    expect(h.errorRate).toBeUndefined();
    const e = await noop.findRuntimeEvidence('a', 'b');
    expect(e.observedCalls).toBe(0);
    expect(e.sample).toEqual([]);
  });
});
