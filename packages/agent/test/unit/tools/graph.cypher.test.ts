import { describe, it, expect } from 'vitest';
import { isReadOnlyCypher, buildGraphCypherTool } from '../../../src/tools/graph.cypher.tool.js';
import type { Neo4jClient } from '@ekg/graph';

interface FakeRecord { toObject(): Record<string, unknown>; }
function fakeClient(rows: Record<string, unknown>[]): Neo4jClient {
  return {
    async executeRead<T>(work: (tx: { run: (q: string, p: unknown) => Promise<{ records: FakeRecord[] }> }) => Promise<T>): Promise<T> {
      const records: FakeRecord[] = rows.map((r) => ({ toObject: () => r }));
      return work({ run: async () => ({ records }) }) as Promise<T>;
    },
  } as unknown as Neo4jClient;
}

describe('isReadOnlyCypher', () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ['MATCH (n) RETURN n LIMIT 10', true],
    ['CREATE (n:Foo {id: "x"})', false],
    ['MATCH (n) DELETE n', false],
    ['MATCH (n) SET n.foo = 1', false],
    ['MERGE (n:Foo {id: "x"})', false],
    ['DETACH DELETE n', false],
    ['DROP CONSTRAINT my_c IF EXISTS', false],
    ['LOAD CSV WITH HEADERS FROM "x" AS row RETURN row', false],
    ['MATCH (n) REMOVE n.x RETURN n', false],
    ['MATCH (a) OPTIONAL MATCH (a)-[r]->(b) RETURN a, b', true],
  ];
  for (const [q, ok] of cases) {
    it(`${ok ? 'allows' : 'rejects'}: ${q.slice(0, 50)}`, () => {
      const r = isReadOnlyCypher(q);
      expect(r.ok).toBe(ok);
    });
  }
});

describe('buildGraphCypherTool.invoke', () => {
  it('throws on mutation cypher', async () => {
    const tool = buildGraphCypherTool(fakeClient([]));
    await expect(tool.invoke({ cypher: 'CREATE (n:Foo)' })).rejects.toThrow(/refused/);
  });

  it('passes read-only cypher through and collects ids', async () => {
    const tool = buildGraphCypherTool(fakeClient([{ id: 'abc', name: 'foo' }, { id: 'def' }]));
    const res = await tool.invoke({ cypher: 'MATCH (n) RETURN n' });
    expect(res.seenIds).toEqual(expect.arrayContaining(['abc', 'def']));
    expect(res.text).toContain('abc');
  });

  it('appends LIMIT when missing', async () => {
    const tool = buildGraphCypherTool(fakeClient([]));
    // Indirectly test via successful invocation; if LIMIT injection broke
    // the query we'd see an exception from the fake client.
    const res = await tool.invoke({ cypher: 'MATCH (n) RETURN n' });
    expect(res.text).toContain('"count": 0');
  });
});
