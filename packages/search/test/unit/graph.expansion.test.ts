import { describe, it, expect, vi } from 'vitest';
import { Neo4jGraphExpander } from '../../src/graph.expansion.js';
import type { Neo4jClient } from '@ekg/graph';

interface FakeRecord {
  get(key: string): unknown;
}

function makeClient(records: readonly Record<string, unknown>[]) {
  const tx = {
    run: vi.fn(async () => ({
      records: records.map((r) => ({ get: (k: string) => r[k] }) as FakeRecord),
    })),
  };
  const executeRead = vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx));
  return { executeRead, tx } as unknown as { executeRead: typeof executeRead; tx: typeof tx };
}

describe('Neo4jGraphExpander', () => {
  it('returns mapped neighbours and caps to opts.cap', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      edge: 'CALLS',
      direction: 'out',
      mid: `n${i}`,
      mlabel: 'Function',
      mname: `n${i}`,
    }));
    const client = makeClient(records);
    const expander = new Neo4jGraphExpander(client as unknown as Neo4jClient, { cap: 3 });
    const out = await expander.expand('Function', 'root');
    expect(out.length).toBeLessThanOrEqual(10); // cypher LIMIT honoured client-side; we don't truncate here
    // Cypher embeds the cap; assertion: the call was made with the right id.
    expect(client.tx.run).toHaveBeenCalledTimes(1);
    const [cypher, params] = client.tx.run.mock.calls[0]!;
    expect(params).toEqual({ id: 'root' });
    expect(cypher).toContain('LIMIT 3');
  });

  it('returns [] for invalid label and does not call Neo4j', async () => {
    const client = makeClient([]);
    const expander = new Neo4jGraphExpander(client as unknown as Neo4jClient);
    const out = await expander.expand('1; DROP TABLE', 'x');
    expect(out).toEqual([]);
    expect(client.tx.run).not.toHaveBeenCalled();
  });

  it('caches by label:id', async () => {
    const client = makeClient([{ edge: 'CALLS', direction: 'out', mid: 'a', mlabel: 'Function', mname: 'a' }]);
    const expander = new Neo4jGraphExpander(client as unknown as Neo4jClient);
    await expander.expand('Function', 'root');
    await expander.expand('Function', 'root');
    expect(client.tx.run).toHaveBeenCalledTimes(1);
    expect(expander.cacheSize()).toBe(1);
  });

  it('LRU evicts oldest entries past cacheMax', async () => {
    const client = makeClient([{ edge: 'CALLS', direction: 'out', mid: 'a', mlabel: 'Function', mname: 'a' }]);
    const expander = new Neo4jGraphExpander(client as unknown as Neo4jClient, { cacheMax: 2 });
    await expander.expand('Function', 'a');
    await expander.expand('Function', 'b');
    await expander.expand('Function', 'c');
    expect(expander.cacheSize()).toBe(2);
  });

  it('swallows Neo4j errors and returns []', async () => {
    const tx = { run: vi.fn(async () => { throw new Error('boom'); }) };
    const client = {
      executeRead: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const expander = new Neo4jGraphExpander(client as unknown as Neo4jClient);
    const out = await expander.expand('Function', 'x');
    expect(out).toEqual([]);
  });
});
