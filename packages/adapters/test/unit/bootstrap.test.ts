import { describe, it, expect } from 'vitest';
import { bootstrapAdapters } from '../../src/bootstrap.js';
import type { AdapterContext, McpAdapter } from '../../src/adapter.interface.js';

function fakeAdapter(ctx: AdapterContext, opts: { failConnect?: boolean } = {}): McpAdapter {
  return {
    id: ctx.id,
    capabilities: ['metrics'],
    context: ctx,
    async connect() { if (opts.failConnect) throw new Error('connect failed'); },
    async disconnect() {},
    async healthCheck() { return !opts.failConnect; },
  };
}

describe('bootstrapAdapters', () => {
  it('skips disabled adapters', async () => {
    const { registry } = await bootstrapAdapters({
      configs: [{ id: 'foo', enabled: false, transport: 'stdio', serviceMapping: 'auto', capabilities: ['metrics'], priority: 0 }],
      factories: { foo: (ctx) => fakeAdapter(ctx) },
    });
    expect(registry.size()).toBe(0);
  });

  it('warns and skips adapter ids without a factory', async () => {
    const { registry } = await bootstrapAdapters({
      configs: [{ id: 'mystery', enabled: true, transport: 'stdio', serviceMapping: 'auto', capabilities: ['logs'], priority: 0 }],
      factories: {},
    });
    expect(registry.size()).toBe(0);
  });

  it('registers and connects enabled adapter', async () => {
    const { registry } = await bootstrapAdapters({
      configs: [{ id: 'foo', enabled: true, transport: 'stdio', serviceMapping: 'auto', capabilities: ['metrics'], priority: 7 }],
      factories: { foo: (ctx) => fakeAdapter(ctx) },
    });
    expect(registry.size()).toBe(1);
    expect(registry.getById('foo')?.id).toBe('foo');
    const all = registry.listAll();
    expect(all[0]?.priority).toBe(7);
    expect(all[0]?.healthy).toBe(true);
  });

  it('marks adapter unhealthy when connect fails', async () => {
    const { registry } = await bootstrapAdapters({
      configs: [{ id: 'foo', enabled: true, transport: 'stdio', serviceMapping: 'auto', capabilities: ['metrics'], priority: 0 }],
      factories: { foo: (ctx) => fakeAdapter(ctx, { failConnect: true }) },
    });
    expect(registry.size()).toBe(1);
    const entry = registry.listAll()[0];
    expect(entry?.healthy).toBe(false);
  });

  it('expands env refs into context.env', async () => {
    let captured: AdapterContext | undefined;
    await bootstrapAdapters({
      env: { DD_API_KEY: 'k1' } as NodeJS.ProcessEnv,
      configs: [{
        id: 'foo', enabled: true, transport: 'stdio', serviceMapping: 'auto',
        capabilities: ['metrics'], priority: 0,
        env: { DD_API_KEY: '${DD_API_KEY}' },
      }],
      factories: {
        foo: (ctx) => { captured = ctx; return fakeAdapter(ctx); },
      },
    });
    expect(captured?.env['DD_API_KEY']).toBe('k1');
  });
});
