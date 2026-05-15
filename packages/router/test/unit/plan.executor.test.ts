import { describe, it, expect, vi } from 'vitest';
import type { HybridSearch, HybridResult } from '@ekg/search';
import type { Neo4jClient } from '@ekg/graph';
import { executePlan } from '../../src/plan.executor.js';
import type { RetrievalStrategy } from '../../src/strategy.selector.js';

interface FakeRecord {
  toObject(): Record<string, unknown>;
  get(_key: string): unknown;
}

function makeNeo4j(rows: readonly Record<string, unknown>[]): Neo4jClient {
  const records: FakeRecord[] = rows.map((r) => ({
    toObject: () => r,
    get: (k: string) => r[k],
  }));
  const client = {
    executeRead: vi.fn(async (work: (tx: { run: (q: string, p: unknown) => Promise<{ records: FakeRecord[] }> }) => Promise<unknown>) => {
      return work({
        run: async () => ({ records }),
      });
    }),
  } as unknown as Neo4jClient;
  return client;
}

function makeHybrid(results: readonly HybridResult[]): HybridSearch {
  return { search: vi.fn(async () => results) } as unknown as HybridSearch;
}

const SAMPLE_HIT: HybridResult = {
  id: 'Function:abc',
  nodeId: 'abc',
  label: 'Function',
  repoUrl: 'r',
  name: 'doThing',
  path: 'src/x.ts',
  snippet: 'snippet',
  score: 1,
  neighbours: [],
};

describe('executePlan', () => {
  it('graph-only runs templated cypher and skips hybrid', async () => {
    const neo4j = makeNeo4j([{ service: 'auth-service', upstream: [], downstream: [] }]);
    const hybrid = makeHybrid([SAMPLE_HIT]);
    const strategy: RetrievalStrategy = { kind: 'graph-only', cypher: 'topology' };

    const out = await executePlan('what depends on auth-service?', 'topology', strategy, { hybrid, neo4j });

    expect(neo4j.executeRead).toHaveBeenCalledTimes(1);
    expect(hybrid.search).not.toHaveBeenCalled();
    expect(out.results.graph).toHaveLength(1);
    expect(out.results.hybrid).toBeUndefined();
    expect(out.sources).toContain('graph:topology');
    expect(out.entities.serviceNames).toContain('auth-service');
  });

  it('hybrid strategy calls HybridSearch with the correct label', async () => {
    const neo4j = makeNeo4j([]);
    const hybrid = makeHybrid([SAMPLE_HIT]);
    const strategy: RetrievalStrategy = { kind: 'hybrid', label: 'Function' };

    const out = await executePlan('where is doThing implemented?', 'code', strategy, { hybrid, neo4j }, { k: 5 });

    expect(hybrid.search).toHaveBeenCalledWith(
      'where is doThing implemented?',
      expect.objectContaining({ label: 'Function', k: 5 }),
    );
    expect(out.results.hybrid).toHaveLength(1);
    expect(out.results.graph).toBeUndefined();
    expect(out.sources).toContain('hybrid');
  });

  it('graph-then-hybrid uses graph result when non-empty, no hybrid call', async () => {
    const neo4j = makeNeo4j([{ id: 'tab1', label: 'Table', name: 'users' }]);
    const hybrid = makeHybrid([SAMPLE_HIT]);
    const strategy: RetrievalStrategy = { kind: 'graph-then-hybrid', label: 'Table' };

    const out = await executePlan('which table stores users', 'schema', strategy, { hybrid, neo4j });

    expect(neo4j.executeRead).toHaveBeenCalledTimes(1);
    expect(hybrid.search).not.toHaveBeenCalled();
    expect(out.results.graph).toHaveLength(1);
    expect(out.results.hybrid).toBeUndefined();
  });

  it('graph-then-hybrid falls back to hybrid on empty graph result', async () => {
    const neo4j = makeNeo4j([]);
    const hybrid = makeHybrid([SAMPLE_HIT]);
    const strategy: RetrievalStrategy = { kind: 'graph-then-hybrid', label: 'Table' };

    const out = await executePlan('which table stores users', 'schema', strategy, { hybrid, neo4j });

    expect(hybrid.search).toHaveBeenCalledTimes(1);
    expect(out.results.hybrid).toHaveLength(1);
    expect(out.notes.some((n) => n.includes('falling back'))).toBe(true);
    expect(out.sources).toContain('hybrid (fallback)');
  });

  it('multi-hop runs both graph traversal and hybrid', async () => {
    const neo4j = makeNeo4j([{ startId: 'a', startName: 'flow', terminals: [] }]);
    const hybrid = makeHybrid([SAMPLE_HIT]);
    const strategy: RetrievalStrategy = { kind: 'multi-hop', startLabel: 'API' };

    const out = await executePlan('what happens when user signs up', 'flow', strategy, { hybrid, neo4j });

    expect(neo4j.executeRead).toHaveBeenCalledTimes(1);
    expect(hybrid.search).toHaveBeenCalledTimes(1);
    expect(out.results.multiHop).toBeDefined();
    expect(out.results.multiHop?.seeds).toHaveLength(1);
    expect(out.results.multiHop?.hybrid).toHaveLength(1);
  });

  it('history (commits) returns notes about placeholder', async () => {
    const neo4j = makeNeo4j([{ commits: [] }]);
    const hybrid = makeHybrid([]);
    const strategy: RetrievalStrategy = { kind: 'graph-only', cypher: 'commits' };

    const out = await executePlan('when did we add X?', 'history', strategy, { hybrid, neo4j });
    expect(out.notes.join(' ')).toMatch(/Phase 1\.7/);
  });

  it('records duration_ms', async () => {
    const neo4j = makeNeo4j([]);
    const hybrid = makeHybrid([]);
    const strategy: RetrievalStrategy = { kind: 'hybrid' };
    const out = await executePlan('whatever', 'unknown', strategy, { hybrid, neo4j });
    expect(out.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
