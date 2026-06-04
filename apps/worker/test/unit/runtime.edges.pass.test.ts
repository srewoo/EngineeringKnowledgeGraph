/**
 * Unit tests for RuntimeEdgesPass orchestration — we cover the paths that
 * short-circuit before touching Neo4j (no DB stub required):
 *   - adapter missing capability → graceful skip
 *   - adapter throws → captured into `skipped`, never re-thrown
 *   - empty dependency list → 0 merged, 0 unmatched
 *
 * The matching/merge Cypher path is exercised by integration tests that run
 * against a live Neo4j; unit-mocking it would duplicate the query string
 * without verifying behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import { RuntimeEdgesPass } from '../../src/runtime.edges.pass.js';
import type { McpAdapter } from '@ekg/adapters';
import type { Neo4jClient } from '@ekg/graph';

function makeAdapter(over: Partial<McpAdapter>): McpAdapter {
  return {
    id: 'fake',
    capabilities: [],
    context: { id: 'fake', env: {}, config: {} },
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => true,
    ...over,
  } as McpAdapter;
}

// Neo4jClient is only touched once we have edges to merge — pass an opaque
// object; the tests below never hit a path that uses it.
const stubClient = {} as Neo4jClient;

describe('RuntimeEdgesPass', () => {
  it('skips when adapter does not implement getServiceDependencies', async () => {
    const pass = new RuntimeEdgesPass(stubClient);
    const adapter = makeAdapter({}); // no getServiceDependencies
    const result = await pass.run({
      adapter,
      timeRange: { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-01-01T01:00:00Z' },
    });
    expect(result.edgesObserved).toBe(0);
    expect(result.edgesMerged).toBe(0);
    expect(result.skipped).toMatch(/does not implement/);
  });

  it('captures adapter errors as skip reason without throwing', async () => {
    const pass = new RuntimeEdgesPass(stubClient);
    const adapter = makeAdapter({
      getServiceDependencies: vi.fn(async () => {
        throw new Error('datadog 503');
      }),
    });
    const result = await pass.run({
      adapter,
      timeRange: { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-01-01T01:00:00Z' },
    });
    expect(result.edgesMerged).toBe(0);
    expect(result.skipped).toMatch(/adapter error: datadog 503/);
  });

  it('returns 0/0 when adapter reports no dependencies', async () => {
    const pass = new RuntimeEdgesPass(stubClient);
    const adapter = makeAdapter({
      getServiceDependencies: vi.fn(async () => []),
    });
    const result = await pass.run({
      adapter,
      timeRange: { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-01-01T01:00:00Z' },
    });
    expect(result.edgesObserved).toBe(0);
    expect(result.edgesMerged).toBe(0);
    expect(result.unmatched).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });
});
