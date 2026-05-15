import { describe, it, expect } from 'vitest';
import {
  buildSnapshot,
  snapshotByteSize,
  type RawCrossEdge,
  type SnapshotService,
  type SnapshotSource,
} from '../../src/snapshot.builder.js';

class StubSource implements SnapshotSource {
  constructor(
    private readonly services: readonly SnapshotService[],
    private readonly edges: readonly RawCrossEdge[],
    private readonly counts: Readonly<Record<string, number>>,
  ) {}

  async fetchServices(): Promise<readonly SnapshotService[]> { return this.services; }
  async fetchInterServiceEdges(): Promise<readonly RawCrossEdge[]> { return this.edges; }
  async fetchNodeCounts(): Promise<Readonly<Record<string, number>>> { return this.counts; }
}

describe('buildSnapshot', () => {
  it('captures services + dedup edges with kind counts', async () => {
    const source = new StubSource(
      [
        { id: 'svc:a', name: 'a', repoUrl: 'r1' },
        { id: 'svc:b', name: 'b', repoUrl: 'r2' },
      ],
      [
        { fromService: 'a', toService: 'b', kind: 'CALLS_API' },
        { fromService: 'a', toService: 'b', kind: 'CALLS_API' },
        { fromService: 'a', toService: 'b', kind: 'PRODUCES' },
      ],
      { Service: 2, Function: 10 },
    );
    const snap = await buildSnapshot(source);
    expect(snap.version).toBe(1);
    expect(snap.services).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]?.from).toBe('a');
    expect(snap.edges[0]?.kinds).toEqual({ CALLS_API: 2, PRODUCES: 1 });
    expect(snap.summary.serviceCount).toBe(2);
    expect(snap.summary.edgeCount).toBe(1);
    expect(snap.summary.nodeCounts).toEqual({ Service: 2, Function: 10 });
  });

  it('drops self-loops and empty service names', async () => {
    const source = new StubSource(
      [{ id: 'svc:a', name: 'a' }],
      [
        { fromService: 'a', toService: 'a', kind: 'CALLS_API' },
        { fromService: '', toService: 'b', kind: 'CALLS_API' },
        { fromService: 'a', toService: '', kind: 'CALLS_API' },
      ],
      {},
    );
    const snap = await buildSnapshot(source);
    expect(snap.edges).toHaveLength(0);
  });

  it('snapshotByteSize returns positive integer', () => {
    const empty = {
      version: 1 as const,
      capturedAt: '2026-05-15T00:00:00Z',
      services: [],
      edges: [],
      summary: { nodeCounts: {}, edgeCount: 0, serviceCount: 0 },
    };
    expect(snapshotByteSize(empty)).toBeGreaterThan(0);
  });
});
