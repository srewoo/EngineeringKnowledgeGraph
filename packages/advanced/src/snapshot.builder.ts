/**
 * Snapshot builder — captures a deterministic projection of the current graph
 * suitable for architecture-diff over time.
 *
 * The snapshot is intentionally lossy: only services, summary counts, and a
 * de-duplicated set of inter-service edges. We do NOT snapshot every File or
 * Function — that would balloon the SQLite payload and is not what diffs care
 * about (architecture moves, not function bodies).
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Neo4jClient } from '@ekg/graph';

export const SNAPSHOT_WARN_BYTES = 5 * 1024 * 1024;

export interface SnapshotService {
  readonly id: string;
  readonly name: string;
  readonly repoUrl?: string;
}

export interface SnapshotEdge {
  readonly from: string;
  readonly to: string;
  /** Map of edge-kind -> count, e.g. { CALLS_API: 4, PRODUCES: 1 }. */
  readonly kinds: Readonly<Record<string, number>>;
}

export interface SnapshotSummary {
  readonly nodeCounts: Readonly<Record<string, number>>;
  readonly edgeCount: number;
  readonly serviceCount: number;
}

export interface SnapshotPayload {
  readonly version: 1;
  readonly capturedAt: string;
  readonly services: readonly SnapshotService[];
  readonly edges: readonly SnapshotEdge[];
  readonly summary: SnapshotSummary;
}

export interface SnapshotSource {
  fetchServices(): Promise<readonly SnapshotService[]>;
  fetchInterServiceEdges(): Promise<readonly RawCrossEdge[]>;
  fetchNodeCounts(): Promise<Readonly<Record<string, number>>>;
}

export interface RawCrossEdge {
  readonly fromService: string;
  readonly toService: string;
  readonly kind: string;
}

export class Neo4jSnapshotSource implements SnapshotSource {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'snapshot-source' });
  }

  async fetchServices(): Promise<readonly SnapshotService[]> {
    return this.client.executeRead(async (tx) => {
      const r = await tx.run(`
        MATCH (s:Service)
        RETURN coalesce(s.id, '') AS id,
               coalesce(s.name, '') AS name,
               coalesce(s.repoUrl, '') AS repoUrl
        ORDER BY name ASC
      `);
      return r.records.map((rec) => {
        const repoUrl = String(rec.get('repoUrl') ?? '');
        return {
          id: String(rec.get('id') ?? ''),
          name: String(rec.get('name') ?? ''),
          ...(repoUrl ? { repoUrl } : {}),
        } satisfies SnapshotService;
      });
    });
  }

  async fetchInterServiceEdges(): Promise<readonly RawCrossEdge[]> {
    return this.client.executeRead(async (tx) => {
      const r = await tx.run(`
        MATCH (a:Service)
        OPTIONAL MATCH (a)<-[:CONTAINS|DEFINES*1..3]-(:File)<-[:DEFINES]-(:File)
        WITH a
        CALL {
          WITH a
          MATCH (a)<-[:CONTAINS|EXPOSES|DEFINES*1..3]->(:File)<-[:DEFINES]-(f:Function)-[:CALLS_API]->(api:API)<-[:EXPOSES]-(b:Service)
          WHERE a <> b
          RETURN b.name AS toName, 'CALLS_API' AS kind
          UNION ALL
          WITH a
          MATCH (a)-[:PRODUCES]->(t:MessageQueue)<-[:CONSUMES]-(b:Service)
          WHERE a <> b
          RETURN b.name AS toName, 'PRODUCES' AS kind
          UNION ALL
          WITH a
          MATCH (b:Service)-[:PRODUCES]->(t:MessageQueue)<-[:CONSUMES]-(a)
          WHERE a <> b
          RETURN b.name AS toName, 'CONSUMES' AS kind
          UNION ALL
          WITH a
          MATCH (a)-[:OWNS]->(tbl:Table)<-[:QUERIES]-(:Function)<-[:DEFINES]-(:File)<-[:CONTAINS]-(b:Service)
          WHERE a <> b
          RETURN b.name AS toName, 'SHARED_TABLE' AS kind
        }
        RETURN a.name AS fromName, toName, kind
      `);
      return r.records.map((rec) => ({
        fromService: String(rec.get('fromName') ?? ''),
        toService: String(rec.get('toName') ?? ''),
        kind: String(rec.get('kind') ?? ''),
      } satisfies RawCrossEdge));
    });
  }

  async fetchNodeCounts(): Promise<Readonly<Record<string, number>>> {
    return this.client.executeRead(async (tx) => {
      const r = await tx.run(`
        MATCH (n)
        WITH labels(n)[0] AS lbl, count(*) AS c
        RETURN coalesce(lbl, '') AS lbl, c AS c
      `);
      const out: Record<string, number> = {};
      for (const rec of r.records) {
        const lbl = String(rec.get('lbl') ?? '');
        const c = rec.get('c');
        out[lbl] = typeof c === 'number'
          ? c
          : (c && typeof (c as { toNumber?: () => number }).toNumber === 'function'
            ? (c as { toNumber: () => number }).toNumber() : Number(c) || 0);
      }
      return out;
    });
  }
}

export async function buildSnapshot(source: SnapshotSource): Promise<SnapshotPayload> {
  const [services, rawEdges, counts] = await Promise.all([
    source.fetchServices(),
    source.fetchInterServiceEdges(),
    source.fetchNodeCounts(),
  ]);
  const edges = dedupEdges(rawEdges);
  const payload: SnapshotPayload = {
    version: 1,
    capturedAt: new Date().toISOString(),
    services,
    edges,
    summary: {
      nodeCounts: counts,
      edgeCount: edges.length,
      serviceCount: services.length,
    },
  };
  return payload;
}

export function snapshotByteSize(payload: SnapshotPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function dedupEdges(raw: readonly RawCrossEdge[]): readonly SnapshotEdge[] {
  const map = new Map<string, { from: string; to: string; kinds: Record<string, number> }>();
  for (const e of raw) {
    if (!e.fromService || !e.toService || e.fromService === e.toService) continue;
    const key = `${e.fromService}->${e.toService}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { from: e.fromService, to: e.toService, kinds: {} };
      map.set(key, bucket);
    }
    bucket.kinds[e.kind] = (bucket.kinds[e.kind] ?? 0) + 1;
  }
  return [...map.values()]
    .map((b) => ({ from: b.from, to: b.to, kinds: b.kinds }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
