/**
 * Code-change impact analysis.
 *
 * Given a target node (Column / Function / Table / API), traverse the graph
 * along well-known dependency edges and report direct + transitive impacted
 * nodes, aggregated by service and repo.
 *
 * Pure deterministic. Caps depth at 4 and per-layer node count at 200.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Neo4jClient } from '@ekg/graph';
import {
  prune,
  DEFAULT_PRUNING_POLICY,
  DEFAULT_MAX_NODES_PER_LAYER,
  type PruningPolicy,
} from './traversal.pruning.js';

/**
 * Hard ceiling on traversal depth. Raised from 4 to 8 to reach 2nd-tier
 * dependencies (e.g. column → table → query → function → caller → caller's
 * caller → service boundary). Pruning policies keep the candidate set bounded.
 */
export const IMPACT_MAX_DEPTH = 8;
export const IMPACT_PER_LAYER_CAP = 200;

export type ImpactLabel = 'Column' | 'Function' | 'Table' | 'API';

export interface ImpactTarget {
  readonly label: ImpactLabel;
  readonly id: string;
}

export interface NodeRef {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly distance: number;
  readonly serviceName?: string;
  readonly repoUrl?: string;
}

export interface ImpactReport {
  readonly target: ImpactTarget;
  readonly directImpact: readonly NodeRef[];
  readonly transitiveImpact: readonly NodeRef[];
  readonly byService: Readonly<Record<string, number>>;
  readonly byRepo: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

export interface ImpactExecutor {
  query(label: ImpactLabel, id: string, depth: number, perLayer: number): Promise<readonly RawImpactRow[]>;
}

export interface RawImpactRow {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly distance: number;
  readonly serviceName?: string;
  readonly repoUrl?: string;
  /** Number of distinct call sites for `byCallCount` pruning. */
  readonly callSites?: number;
  /** Source-side service for an incoming edge — used by `ownership` pruning. */
  readonly fromService?: string;
}

export interface ImpactOptions {
  readonly maxHops?: number;
  readonly maxNodesPerLayer?: number;
  readonly pruning?: PruningPolicy;
}

export class Neo4jImpactExecutor implements ImpactExecutor {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'impact-executor' });
  }

  async query(label: ImpactLabel, id: string, depth: number, perLayer: number): Promise<readonly RawImpactRow[]> {
    const cypher = buildImpactCypher(label, depth, perLayer);
    const t0 = Date.now();
    const rows = await this.client.executeRead(async (tx) => {
      const r = await tx.run(cypher, { id });
      return r.records.map((rec) => {
        const serviceName = optStr(rec.get('serviceName'));
        const repoUrl = optStr(rec.get('repoUrl'));
        const callSites = toNum(rec.get('callSites'));
        return {
          id: String(rec.get('id') ?? ''),
          label: String(rec.get('lbl') ?? ''),
          name: String(rec.get('name') ?? ''),
          distance: toNum(rec.get('distance')),
          ...(serviceName ? { serviceName } : {}),
          ...(repoUrl ? { repoUrl } : {}),
          ...(callSites > 0 ? { callSites } : {}),
        } satisfies RawImpactRow;
      });
    });
    this.logger.info({ label, id, ms: Date.now() - t0, rows: rows.length }, 'Impact query complete');
    return rows;
  }
}

export async function analyzeImpact(
  exec: ImpactExecutor,
  target: ImpactTarget,
  opts: ImpactOptions = {},
): Promise<ImpactReport> {
  const depth = clampDepth(opts.maxHops ?? IMPACT_MAX_DEPTH);
  const perLayer = clampPerLayer(opts.maxNodesPerLayer ?? IMPACT_PER_LAYER_CAP);
  const rawRows = await exec.query(target.label, target.id, depth, perLayer);
  // Deterministic pruning before aggregation so byService/byRepo reflect the
  // pruned set (otherwise counts diverge from what the caller can inspect).
  const rows = prune(rawRows, {
    policy: opts.pruning ?? DEFAULT_PRUNING_POLICY,
    maxNodesPerLayer: opts.maxNodesPerLayer ?? DEFAULT_MAX_NODES_PER_LAYER,
  });
  const direct: NodeRef[] = [];
  const transitive: NodeRef[] = [];
  const byService: Record<string, number> = {};
  const byRepo: Record<string, number> = {};

  for (const r of rows) {
    if (!r.id || r.id === target.id) continue;
    const ref: NodeRef = {
      id: r.id,
      label: r.label,
      name: r.name,
      distance: r.distance,
      ...(r.serviceName ? { serviceName: r.serviceName } : {}),
      ...(r.repoUrl ? { repoUrl: r.repoUrl } : {}),
    };
    if (r.distance <= 1) direct.push(ref); else transitive.push(ref);
    if (ref.serviceName) byService[ref.serviceName] = (byService[ref.serviceName] ?? 0) + 1;
    if (ref.repoUrl) byRepo[ref.repoUrl] = (byRepo[ref.repoUrl] ?? 0) + 1;
  }

  direct.sort(byDistanceThenName);
  transitive.sort(byDistanceThenName);

  return {
    target,
    directImpact: direct,
    transitiveImpact: transitive,
    byService: sortRecord(byService),
    byRepo: sortRecord(byRepo),
    generatedAt: new Date().toISOString(),
  };
}

function buildImpactCypher(label: ImpactLabel, depth: number, perLayer: number): string {
  const d = clampDepth(depth);
  const cap = Math.max(1, Math.min(perLayer, IMPACT_PER_LAYER_CAP));
  // Per-label traversal patterns. All anchored on `target {id: $id}`.
  const pattern = labelPattern(label, d);
  return `
    MATCH (target:${label} {id: $id})
    ${pattern}
    WITH DISTINCT n, length(p) AS distance
    WHERE n.id <> $id
    OPTIONAL MATCH (svc:Service)
    WHERE svc.id = coalesce(n.serviceId, '__none__')
       OR svc.name = coalesce(n.serviceName, '__none__')
    OPTIONAL MATCH (n)-[cs:CALLS]->()
    WITH n, distance, svc, count(DISTINCT cs) AS callSites
    RETURN
      coalesce(n.id, '') AS id,
      coalesce(labels(n)[0], '') AS lbl,
      coalesce(n.name, '') AS name,
      distance AS distance,
      coalesce(svc.name, n.serviceName, '') AS serviceName,
      coalesce(n.repoUrl, '') AS repoUrl,
      callSites AS callSites
    ORDER BY distance ASC
    LIMIT ${cap * d}
  `.trim();
}

function labelPattern(label: ImpactLabel, depth: number): string {
  switch (label) {
    case 'Column':
      return `OPTIONAL MATCH p = (target)<-[:HAS*1..1]-(:Table)<-[:QUERIES|OWNS*1..${depth}]-(n)`;
    case 'Function':
      return `OPTIONAL MATCH p = (target)<-[:CALLS*1..${depth}]-(n)`;
    case 'Table':
      return `OPTIONAL MATCH p = (target)<-[:OWNS|QUERIES|ALTERS*1..${depth}]-(n)`;
    case 'API':
      return `OPTIONAL MATCH p = (target)<-[:CALLS_API|EXPOSES*1..${depth}]-(n)`;
  }
}

export function clampDepth(d: number): number {
  if (!Number.isFinite(d) || d < 1) return 1;
  return Math.min(Math.floor(d), IMPACT_MAX_DEPTH);
}

export function clampPerLayer(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), IMPACT_PER_LAYER_CAP);
}

function byDistanceThenName(a: NodeRef, b: NodeRef): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.name.localeCompare(b.name);
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}
