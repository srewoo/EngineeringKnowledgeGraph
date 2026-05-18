import { describe, it, expect } from 'vitest';
import type { GraphNode, GraphRelationship } from '@ekg/shared';
import { SchemaDriftDetector } from '../../src/schema.drift.js';

const REPO = 'https://gitlab.com/o/r';

function table(name: string): GraphNode {
  return {
    id: `table:${REPO}:${name}`,
    label: 'Table',
    name,
    properties: { name, repoUrl: REPO },
  };
}
function column(table: string, col: string): GraphNode {
  return {
    id: `table:${REPO}:${table}:${col}`,
    label: 'Column',
    name: col,
    properties: { tableId: `table:${REPO}:${table}`, name: col, type: 'TEXT', nullable: true, isPrimary: false, isUnique: false },
  };
}
function migration(name: string): GraphNode {
  return {
    id: `migration:${REPO}:db/${name}`,
    label: 'Migration',
    name,
    properties: { name, repoUrl: REPO, filePath: `db/${name}` },
  };
}
function ownsService(svc: string, target: string): GraphRelationship {
  return {
    type: 'OWNS',
    sourceId: `service:${svc}`,
    targetId: target,
    confidence: 'HIGH',
    properties: {},
  };
}

describe('SchemaDriftDetector', () => {
  const det = new SchemaDriftDetector();

  it('flags drift when a Migration node is present', () => {
    const nodes = [migration('V1__init.sql'), table('users'), column('users', 'id')];
    const rels: GraphRelationship[] = [];
    const sig = det.detect(nodes, rels, undefined);
    expect(sig.drifted).toBe(true);
    expect(sig.newMigrations).toHaveLength(1);
    expect(sig.newTables).toHaveLength(1);
    expect(sig.newColumns).toHaveLength(1);
  });

  it('returns no drift when only existing nodes are present', () => {
    const nodes = [table('users')];
    const rels: GraphRelationship[] = [];
    const fakeRepo = {
      findByNodeId: (_id: string) => ({} as unknown),
    } as unknown as Parameters<typeof det.detect>[2];
    const sig = det.detect(nodes, rels, fakeRepo);
    expect(sig.drifted).toBe(false);
  });

  it('resolves affected services via OWNS edges', () => {
    const nodes = [table('orders'), table('items'), migration('V2__add.sql')];
    const rels: GraphRelationship[] = [
      ownsService('orders-svc', `table:${REPO}:orders`),
      ownsService('catalog-svc', `table:${REPO}:items`),
    ];
    const sig = det.detect(nodes, rels, undefined);
    expect(sig.drifted).toBe(true);
    expect(sig.affectedServices.sort()).toEqual([
      'service:catalog-svc',
      'service:orders-svc',
    ]);
  });

  it('picks up tables touched by ALTERS even if Table node is not new', () => {
    // Table node missing, but ALTERS edge points at it.
    const nodes = [migration('V3__alter.sql')];
    const rels: GraphRelationship[] = [
      {
        type: 'ALTERS',
        sourceId: `migration:${REPO}:db/V3__alter.sql`,
        targetId: `table:${REPO}:legacy`,
        confidence: 'HIGH',
        properties: { kind: 'ALTER' },
      },
      ownsService('legacy-svc', `table:${REPO}:legacy`),
    ];
    const sig = det.detect(nodes, rels, undefined);
    expect(sig.drifted).toBe(true);
    expect(sig.affectedServices).toEqual(['service:legacy-svc']);
  });
});
