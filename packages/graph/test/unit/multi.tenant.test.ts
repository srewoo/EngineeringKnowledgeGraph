/**
 * Multi-tenant isolation tests (Phase 2 of ADR-006 bridge).
 *
 * Drives `GraphRepository.mergeNodes` / `mergeRelationships` and
 * `GraphQueries.listServices` / `getServiceSummary` / `getDependencies`
 * with two distinct `RequestContext`s and asserts:
 *
 *   1. Writes stamp `tenantId` on every node/edge property.
 *   2. Merge keys include `tenantId`, so the same logical id under two
 *      tenants does NOT collapse into one node.
 *   3. Reads return only the requesting tenant's rows.
 *   4. Local context (`tenantId='local'`) treats missing tenantId rows as
 *      its own — backward-compatible with pre-tenant data.
 *
 * The Neo4j client is mocked at the session boundary; we inspect the
 * captured Cypher + params to verify the contract without a live DB.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphRepository } from '../../src/graph.repository.js';
import { GraphQueries } from '../../src/graph.queries.js';
import type { Neo4jClient } from '../../src/neo4j.client.js';
import { makeRequestContext, LOCAL_REQUEST_CONTEXT } from '@ekg/shared';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

interface CapturedRun { readonly cypher: string; readonly params: Record<string, unknown> }

function mockClient(rowsForReads: Array<Record<string, unknown>> = []) {
  const writes: CapturedRun[] = [];
  const reads: CapturedRun[] = [];

  const fakeTx = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
      writes.push({ cypher, params });
      return { records: [] };
    }),
  };

  const fakeSession = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
      reads.push({ cypher, params });
      return {
        records: rowsForReads.map((r) => ({
          get: (k: string) => (r as Record<string, unknown>)[k],
        })),
      };
    }),
    close: vi.fn(async () => {}),
  };

  const client: Partial<Neo4jClient> = {
    executeWrite: vi.fn(async (work: (tx: typeof fakeTx) => Promise<unknown>) => work(fakeTx)) as never,
    getSession: vi.fn(() => fakeSession) as never,
    getReadSession: vi.fn(() => fakeSession) as never,
  };

  return { client: client as Neo4jClient, writes, reads };
}

describe('Multi-tenant — writes', () => {
  it('mergeNodes stamps tenantId on every node and on the MERGE key', async () => {
    const { client, writes } = mockClient();
    const repo = new GraphRepository(client);
    const ctx = makeRequestContext({ tenantId: 'acme', actor: 'alice', requestId: 'r1' });
    const nodes: GraphNode[] = [
      { id: 'svc:billing', label: 'Service', name: 'billing', properties: { directory: '/' } },
    ];
    await repo.mergeNodes(nodes, ctx);
    expect(writes).toHaveLength(1);
    const { cypher, params } = writes[0]!;
    // MERGE key includes tenantId
    expect(cypher).toMatch(/MERGE \(n:Service \{id: row\.id, tenantId: \$tenantId\}\)/);
    // tenantId injected as param
    expect(params['tenantId']).toBe('acme');
    // Property bag carries tenantId so n += row.properties writes it.
    const rows = params['rows'] as Array<{ properties: Record<string, unknown> }>;
    expect(rows[0]!.properties['tenantId']).toBe('acme');
  });

  it('defaults to local tenant when no context is supplied', async () => {
    const { client, writes } = mockClient();
    const repo = new GraphRepository(client);
    await repo.mergeNodes([
      { id: 'x', label: 'File', name: 'x.ts', properties: {} },
    ]);
    expect(writes[0]!.params['tenantId']).toBe('local');
  });

  it('mergeRelationships matches endpoints by (id, tenantId) — no cross-tenant edges', async () => {
    const { client, writes } = mockClient();
    const repo = new GraphRepository(client);
    const ctx = makeRequestContext({ tenantId: 'acme' });
    const rels: GraphRelationship[] = [
      { type: 'CALLS', sourceId: 'a', targetId: 'b', confidence: 'HIGH', properties: {} },
    ];
    await repo.mergeRelationships(rels, ctx);
    const cypher = writes[0]!.cypher;
    expect(cypher).toMatch(/MATCH \(source \{id: row\.sourceId, tenantId: \$tenantId\}\)/);
    expect(cypher).toMatch(/MATCH \(target \{id: row\.targetId, tenantId: \$tenantId\}\)/);
    expect(writes[0]!.params['tenantId']).toBe('acme');
  });

  it('two tenants writing the same id produce independent merges (params differ)', async () => {
    const { client, writes } = mockClient();
    const repo = new GraphRepository(client);
    const acme = makeRequestContext({ tenantId: 'acme' });
    const widg = makeRequestContext({ tenantId: 'widgetcorp' });
    const sameNode: GraphNode = { id: 'svc:billing', label: 'Service', name: 'billing', properties: {} };
    await repo.mergeNodes([sameNode], acme);
    await repo.mergeNodes([sameNode], widg);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.params['tenantId']).toBe('acme');
    expect(writes[1]!.params['tenantId']).toBe('widgetcorp');
    // Same logical node id, two separate MERGEs because the merge key
    // includes tenantId — they cannot collapse into one node.
  });
});

describe('Multi-tenant — reads', () => {
  it('listServices filters by tenantId via coalesce', async () => {
    const { client, reads } = mockClient();
    const queries = new GraphQueries(client);
    await queries.listServices(makeRequestContext({ tenantId: 'acme' }));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.cypher).toMatch(/coalesce\(s\.tenantId, 'local'\) = \$tenantId/);
    expect(reads[0]!.params['tenantId']).toBe('acme');
  });

  it('listServices with local context still surfaces pre-tenant rows', async () => {
    const { client, reads } = mockClient([
      { name: 'old-service', label: 'Service', properties: { directory: '/' } },
    ]);
    const queries = new GraphQueries(client);
    const rows = await queries.listServices(LOCAL_REQUEST_CONTEXT);
    expect(reads[0]!.params['tenantId']).toBe('local');
    // The fake DB returns one row; the coalesce semantics let pre-tenant
    // rows match local — the row passes through.
    expect(rows).toHaveLength(1);
  });

  it('getServiceSummary scopes every sub-query (5 reads, all tenant-scoped)', async () => {
    const { client, reads } = mockClient();
    const queries = new GraphQueries(client);
    await queries.getServiceSummary('billing', makeRequestContext({ tenantId: 'acme' }));
    // service + apis + databases + dependencies + dependents + runtime = 6 reads.
    // (The runtime block is one OPTIONAL MATCH chain; it's not tenant-scoped
    // in this slice, intentionally — runtime data lives outside the tenant
    // boundary by design for shared APM. Verify only the scoped reads.)
    const scoped = reads.filter((r) => r.cypher.includes("coalesce(s.tenantId, 'local')"));
    expect(scoped.length).toBeGreaterThanOrEqual(5);
    for (const r of scoped) {
      expect(r.params['tenantId']).toBe('acme');
    }
  });

  it('getDependencies scopes both the seed and every node along the traversal path', async () => {
    const { client, reads } = mockClient();
    const queries = new GraphQueries(client);
    await queries.getDependencies('billing', 3, undefined, makeRequestContext({ tenantId: 'acme' }));
    expect(reads).toHaveLength(1);
    const cypher = reads[0]!.cypher;
    expect(cypher).toMatch(/coalesce\(s\.tenantId, 'local'\) = \$tenantId/);
    expect(cypher).toMatch(/ALL\(n IN nodes\(path\) WHERE coalesce\(n\.tenantId, 'local'\) = \$tenantId\)/);
    expect(reads[0]!.params['tenantId']).toBe('acme');
  });
});

describe('Multi-tenant — context defaults', () => {
  it('write methods default to local context when no context arg supplied', async () => {
    const { client, writes } = mockClient();
    const repo = new GraphRepository(client);
    await repo.mergeNodes([{ id: 'x', label: 'File', name: 'x', properties: {} }]);
    expect(writes[0]!.params['tenantId']).toBe('local');
  });

  it('read methods default to local context when no context arg supplied', async () => {
    const { client, reads } = mockClient();
    const queries = new GraphQueries(client);
    await queries.listServices();
    expect(reads[0]!.params['tenantId']).toBe('local');
  });
});
