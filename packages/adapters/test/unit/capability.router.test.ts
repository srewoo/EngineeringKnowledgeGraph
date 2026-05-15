import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../../src/adapter.registry.js';
import { CapabilityRouter } from '../../src/capability.router.js';
import type { AdapterCapability, McpAdapter } from '../../src/adapter.interface.js';

function adapter(id: string, caps: readonly AdapterCapability[], impl: Partial<McpAdapter> = {}): McpAdapter {
  return {
    id,
    capabilities: caps,
    context: { id, env: {}, config: {} },
    async connect() {},
    async disconnect() {},
    async healthCheck() { return true; },
    ...impl,
  };
}

describe('CapabilityRouter', () => {
  it('returns [] when no adapters', async () => {
    const router = new CapabilityRouter(new AdapterRegistry());
    expect(await router.route('metrics', () => Promise.resolve(['x']))).toEqual([]);
    expect(router.hasCapability('metrics')).toBe(false);
  });

  it('fans out across all capable adapters', async () => {
    const reg = new AdapterRegistry();
    reg.register(adapter('a', ['metrics']));
    reg.register(adapter('b', ['metrics']));
    reg.register(adapter('c', ['logs']));
    const router = new CapabilityRouter(reg);
    const out = await router.route('metrics', (a) => Promise.resolve(`hello-${a.id}`));
    expect(out.map((r) => r.adapterId).sort()).toEqual(['a', 'b']);
    expect(out.map((r) => r.result).sort()).toEqual(['hello-a', 'hello-b']);
  });

  it('skips adapter that throws — never re-throws', async () => {
    const reg = new AdapterRegistry();
    reg.register(adapter('ok', ['metrics']));
    reg.register(adapter('bad', ['metrics']));
    const router = new CapabilityRouter(reg);
    const out = await router.route('metrics', (a) =>
      a.id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(1),
    );
    expect(out).toEqual([{ adapterId: 'ok', result: 1 }]);
  });

  it('honors timeout per adapter', async () => {
    const reg = new AdapterRegistry();
    reg.register(adapter('slow', ['metrics']));
    reg.register(adapter('fast', ['metrics']));
    const router = new CapabilityRouter(reg, { timeoutMs: 20 });
    const out = await router.route('metrics', (a) =>
      a.id === 'slow' ? new Promise((r) => setTimeout(() => r('late'), 200)) : Promise.resolve('quick'),
    );
    expect(out).toEqual([{ adapterId: 'fast', result: 'quick' }]);
  });

  it('skips adapters that return undefined from fn', async () => {
    const reg = new AdapterRegistry();
    reg.register(adapter('a', ['metrics']));
    const router = new CapabilityRouter(reg);
    const out = await router.route('metrics', () => undefined);
    expect(out).toEqual([]);
  });
});
