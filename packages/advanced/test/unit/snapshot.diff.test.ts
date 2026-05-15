import { describe, it, expect } from 'vitest';
import { diff } from '../../src/snapshot.diff.js';
import type { SnapshotPayload } from '../../src/snapshot.builder.js';

function snap(
  capturedAt: string,
  services: SnapshotPayload['services'],
  edges: SnapshotPayload['edges'],
): SnapshotPayload {
  return {
    version: 1,
    capturedAt,
    services,
    edges,
    summary: { nodeCounts: {}, edgeCount: edges.length, serviceCount: services.length },
  };
}

describe('snapshot diff', () => {
  it('detects added and removed services', () => {
    const a = snap('t1', [{ id: '1', name: 'svc-a' }], []);
    const b = snap('t2', [
      { id: '1', name: 'svc-a' },
      { id: '2', name: 'svc-b' },
    ], []);
    const d = diff(a, b);
    expect(d.addedServices.map((s) => s.name)).toEqual(['svc-b']);
    expect(d.removedServices).toEqual([]);
    expect(d.summary.addedServiceCount).toBe(1);
  });

  it('detects added/removed/changed edges', () => {
    const a = snap('t1', [
      { id: '1', name: 'a' }, { id: '2', name: 'b' }, { id: '3', name: 'c' },
    ], [
      { from: 'a', to: 'b', kinds: { CALLS_API: 1 } },
      { from: 'b', to: 'c', kinds: { PRODUCES: 1 } },
    ]);
    const b = snap('t2', [
      { id: '1', name: 'a' }, { id: '2', name: 'b' }, { id: '3', name: 'c' },
    ], [
      { from: 'a', to: 'b', kinds: { CALLS_API: 2, PRODUCES: 1 } },
      { from: 'a', to: 'c', kinds: { CALLS_API: 1 } },
    ]);
    const d = diff(a, b);
    expect(d.addedEdges.map((e) => `${e.from}->${e.to}`)).toEqual(['a->c']);
    expect(d.removedEdges.map((e) => `${e.from}->${e.to}`)).toEqual(['b->c']);
    expect(d.changedEdges).toHaveLength(1);
    expect(d.changedEdges[0]?.before).toEqual({ CALLS_API: 1 });
    expect(d.changedEdges[0]?.after).toEqual({ CALLS_API: 2, PRODUCES: 1 });
    expect(d.summary).toMatchObject({
      addedEdgeCount: 1,
      removedEdgeCount: 1,
      changedEdgeCount: 1,
      capturedFrom: 't1',
      capturedTo: 't2',
    });
  });

  it('returns empty diff for identical snapshots', () => {
    const s = snap('t', [{ id: '1', name: 'a' }], [
      { from: 'a', to: 'a', kinds: { CALLS_API: 1 } },
    ]);
    const d = diff(s, s);
    expect(d.addedServices).toEqual([]);
    expect(d.removedServices).toEqual([]);
    expect(d.addedEdges).toEqual([]);
    expect(d.removedEdges).toEqual([]);
    expect(d.changedEdges).toEqual([]);
  });
});
