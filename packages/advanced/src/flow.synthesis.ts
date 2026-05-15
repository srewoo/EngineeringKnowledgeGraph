/**
 * Flow synthesis — walk the graph from a seed (route / API / service) outward
 * across HTTP, Kafka and DB boundaries to produce a deterministic FlowGraph.
 *
 * No LLM is involved. The result is a structural projection of the graph
 * that callers (or the Phase 3 agent) can render or narrate.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Neo4jClient } from '@ekg/graph';

export const FLOW_DEFAULT_HOPS = 8;
export const FLOW_MAX_HOPS = 10;

export type FlowSeedKind = 'route' | 'api' | 'service';

export interface FlowSeed {
  readonly kind: FlowSeedKind;
  readonly value: string;
}

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly kind?: string;
}

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
}

export interface FlowPath {
  readonly nodes: readonly string[];
}

export interface FlowGraph {
  readonly seed: FlowSeed;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly paths: readonly FlowPath[];
  readonly truncated: boolean;
}

export interface FlowOptions {
  readonly maxHops?: number;
  readonly includeKafka?: boolean;
}

interface RawPathRow {
  readonly nodes: ReadonlyArray<{ id: string; label: string; name: string; kind?: string }>;
  readonly rels: readonly string[];
}

export interface FlowExecutor {
  walk(seed: FlowSeed, hops: number, includeKafka: boolean): Promise<readonly RawPathRow[]>;
}

export class Neo4jFlowExecutor implements FlowExecutor {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'flow-executor' });
  }

  async walk(seed: FlowSeed, hops: number, includeKafka: boolean): Promise<readonly RawPathRow[]> {
    const cypher = buildFlowCypher(seed, hops, includeKafka);
    const t0 = Date.now();
    const rows = await this.client.executeRead(async (tx) => {
      const r = await tx.run(cypher.query, cypher.params);
      return r.records.map((rec) => {
        const nodes = (rec.get('nodes') as Array<Record<string, unknown>>).map((n) => ({
          id: String(n['id'] ?? ''),
          label: String(n['label'] ?? ''),
          name: String(n['name'] ?? ''),
          kind: n['kind'] != null ? String(n['kind']) : undefined,
        }));
        const rels = (rec.get('rels') as unknown[]).map((t) => String(t));
        return { nodes, rels } satisfies RawPathRow;
      });
    });
    this.logger.info({ ms: Date.now() - t0, paths: rows.length, seed }, 'Flow walk complete');
    return rows;
  }
}

export async function synthesizeFlow(
  exec: FlowExecutor,
  seed: FlowSeed,
  opts: FlowOptions = {},
): Promise<FlowGraph> {
  const hops = clampHops(opts.maxHops ?? FLOW_DEFAULT_HOPS);
  const includeKafka = opts.includeKafka ?? true;
  const rawPaths = await exec.walk(seed, hops, includeKafka);
  return buildFlowGraph(seed, rawPaths);
}

export function clampHops(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > FLOW_MAX_HOPS) return FLOW_MAX_HOPS;
  return Math.floor(n);
}

export function buildFlowGraph(seed: FlowSeed, raw: readonly RawPathRow[]): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edgeKey = new Set<string>();
  const edges: FlowEdge[] = [];
  const paths: FlowPath[] = [];

  for (const row of raw) {
    if (row.nodes.length === 0) continue;
    for (const n of row.nodes) {
      if (!n.id) continue;
      if (!nodes.has(n.id)) {
        const node: FlowNode = n.kind != null
          ? { id: n.id, label: n.label, name: n.name, kind: n.kind }
          : { id: n.id, label: n.label, name: n.name };
        nodes.set(n.id, node);
      }
    }
    for (let i = 0; i < row.nodes.length - 1; i++) {
      const a = row.nodes[i];
      const b = row.nodes[i + 1];
      const t = row.rels[i] ?? 'RELATED';
      if (!a || !b || !a.id || !b.id) continue;
      const key = `${a.id}|${t}|${b.id}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ from: a.id, to: b.id, type: t });
    }
    paths.push({ nodes: row.nodes.map((n) => n.id) });
  }

  return {
    seed,
    nodes: [...nodes.values()],
    edges,
    paths,
    truncated: raw.length >= FLOW_PATH_HARD_CAP,
  };
}

export const FLOW_PATH_HARD_CAP = 200;

interface FlowCypher {
  readonly query: string;
  readonly params: Record<string, unknown>;
}

function buildFlowCypher(seed: FlowSeed, hops: number, includeKafka: boolean): FlowCypher {
  const rels = includeKafka
    ? '[:CALLS|CALLS_API|EXPOSES|PRODUCES|CONSUMES|QUERIES|USES|DEPENDS_ON]'
    : '[:CALLS|CALLS_API|EXPOSES|QUERIES|USES|DEPENDS_ON]';
  // Pin the seed match by kind so we don't bleed into unrelated entry points.
  const seedMatch = seedMatchClause(seed);
  const query = `
    ${seedMatch}
    OPTIONAL MATCH path = (s)-${rels}*1..${hops}-(t)
    WITH path
    WHERE path IS NOT NULL
    WITH path, length(path) AS plen
    ORDER BY plen ASC
    LIMIT ${FLOW_PATH_HARD_CAP}
    RETURN
      [n IN nodes(path) |
        { id: coalesce(n.id, ''),
          label: coalesce(labels(n)[0], ''),
          name: coalesce(n.name, ''),
          kind: coalesce(n.kind, '') }] AS nodes,
      [r IN relationships(path) | type(r)] AS rels
  `.trim();
  return { query, params: { needle: seed.value.toLowerCase() } };
}

function seedMatchClause(seed: FlowSeed): string {
  switch (seed.kind) {
    case 'route':
      return `MATCH (s:API)
              WHERE toLower(coalesce(s.path, '')) CONTAINS $needle
                 OR toLower(coalesce(s.name, '')) CONTAINS $needle`;
    case 'api':
      return `MATCH (s:API)
              WHERE toLower(coalesce(s.id, '')) = $needle
                 OR toLower(coalesce(s.operationId, '')) = $needle
                 OR toLower(coalesce(s.name, '')) CONTAINS $needle`;
    case 'service':
      return `MATCH (s:Service)
              WHERE toLower(coalesce(s.name, '')) = $needle
                 OR toLower(coalesce(s.id, '')) = $needle`;
  }
}
