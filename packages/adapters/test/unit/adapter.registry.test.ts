import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../../src/adapter.registry.js';
import type { AdapterCapability, McpAdapter } from '../../src/adapter.interface.js';

function makeAdapter(id: string, caps: readonly AdapterCapability[], healthy = true): McpAdapter {
  return {
    id,
    capabilities: caps,
    context: { id, env: {}, config: {} },
    async connect() {},
    async disconnect() {},
    async healthCheck() { return healthy; },
  };
}

describe('AdapterRegistry', () => {
  it('starts empty', () => {
    expect(new AdapterRegistry().size()).toBe(0);
  });

  it('registers and retrieves by id', () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter('dd', ['metrics']));
    expect(r.getById('dd')?.id).toBe('dd');
  });

  it('rejects empty id and duplicates', () => {
    const r = new AdapterRegistry();
    expect(() => r.register(makeAdapter('', ['logs']))).toThrow();
    r.register(makeAdapter('dd', ['metrics']));
    expect(() => r.register(makeAdapter('dd', ['logs']))).toThrow();
  });

  it('filters by capability and orders by priority desc', () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter('low', ['errors']), { priority: 1 });
    r.register(makeAdapter('high', ['errors']), { priority: 5 });
    r.register(makeAdapter('mid', ['errors']), { priority: 3 });
    const ids = r.getByCapability('errors').map((a) => a.id);
    expect(ids).toEqual(['high', 'mid', 'low']);
  });

  it('skips unhealthy adapters in capability lookup', () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter('dd', ['metrics']));
    r.register(makeAdapter('alt', ['metrics']));
    r.setHealthy('dd', false);
    expect(r.getByCapability('metrics').map((a) => a.id)).toEqual(['alt']);
  });

  it('healthCheckAll updates entries', async () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter('ok', ['metrics'], true));
    r.register(makeAdapter('bad', ['metrics'], false));
    const result = await r.healthCheckAll();
    expect(result).toEqual({ ok: true, bad: false });
    expect(r.getByCapability('metrics').map((a) => a.id)).toEqual(['ok']);
  });
});
