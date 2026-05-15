import { describe, it, expect, vi } from 'vitest';
import { GraphRepository } from '../../src/graph.repository.js';
import type { Neo4jClient } from '../../src/neo4j.client.js';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

function mockClient() {
  const writeRuns: { cypher: string; params: unknown }[] = [];
  const sessionRuns: { cypher: string; params: unknown }[] = [];

  const fakeTx = {
    run: vi.fn(async (cypher: string, params: unknown) => {
      writeRuns.push({ cypher, params });
      return { records: [] };
    }),
  };

  const fakeSession = {
    run: vi.fn(async (cypher: string, params: unknown) => {
      sessionRuns.push({ cypher, params });
      return { records: [{ get: () => ({ toNumber: () => 0 }) }] };
    }),
    close: vi.fn(async () => {}),
  };

  const client: Partial<Neo4jClient> = {
    executeWrite: vi.fn(async (work: (tx: typeof fakeTx) => Promise<unknown>) => {
      return work(fakeTx) as Promise<unknown>;
    }) as never,
    getSession: vi.fn(() => fakeSession) as never,
    getReadSession: vi.fn(() => fakeSession) as never,
  };

  return { client: client as Neo4jClient, writeRuns, sessionRuns };
}

describe('GraphRepository', () => {
  it('batches node merges by label using UNWIND $rows (not per-node tx.run)', async () => {
    const { client, writeRuns } = mockClient();
    const repo = new GraphRepository(client);

    const nodes: GraphNode[] = [
      { id: 'a', label: 'File', name: 'a', properties: { x: 1 } },
      { id: 'b', label: 'File', name: 'b', properties: { x: 2 } },
      { id: 'm', label: 'Module', name: 'm', properties: {} },
    ];

    const count = await repo.mergeNodes(nodes);
    expect(count).toBe(3);

    // One UNWIND call per label (2 labels) — not 3 individual MERGEs
    expect(writeRuns.length).toBe(2);
    expect(writeRuns[0]?.cypher).toMatch(/UNWIND \$rows AS row/);
    expect(writeRuns[0]?.cypher).toMatch(/MERGE \(n:(File|Module) \{id: row\.id\}\)/);

    const filesParam = (writeRuns.find((r) => /:File /.test(r.cypher))?.params as { rows: unknown[] }).rows;
    expect(filesParam.length).toBe(2);
  });

  it('batches relationships by type', async () => {
    const { client, writeRuns } = mockClient();
    const repo = new GraphRepository(client);

    const rels: GraphRelationship[] = [
      { type: 'IMPORTS', sourceId: 'a', targetId: 'b', confidence: 'HIGH', properties: {} },
      { type: 'IMPORTS', sourceId: 'b', targetId: 'c', confidence: 'HIGH', properties: {} },
      { type: 'USES', sourceId: 'a', targetId: 'db:mongo', confidence: 'HIGH', properties: {} },
    ];
    await repo.mergeRelationships(rels);

    expect(writeRuns.length).toBe(2); // IMPORTS + USES
    expect(writeRuns.every((r) => /UNWIND \$rows/.test(r.cypher))).toBe(true);
  });

  it('deleteBySourceFiles uses one UNWIND for all paths', async () => {
    const { client, sessionRuns } = mockClient();
    const repo = new GraphRepository(client);
    await repo.deleteBySourceFiles(['a.ts', 'b.ts'], 'https://x/repo');
    expect(sessionRuns.length).toBe(1);
    expect(sessionRuns[0]?.cypher).toMatch(/UNWIND \$ids/);
    const ids = (sessionRuns[0]?.params as { ids: string[] }).ids;
    expect(ids).toEqual(['https://x/repo:a.ts', 'https://x/repo:b.ts']);
  });

  it('cleanupOrphans is repo-scoped when repoUrl provided', async () => {
    const { client, sessionRuns } = mockClient();
    const repo = new GraphRepository(client);
    await repo.cleanupOrphans('https://x/repo');
    expect(sessionRuns[0]?.cypher).toMatch(/n\.repoUrl = \$repoUrl/);
  });
});
