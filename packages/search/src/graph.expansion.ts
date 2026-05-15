/**
 * Graph-aware expansion for hybrid search.
 *
 * For each search hit we fetch up to N 1-hop neighbours from Neo4j using a
 * single parameterised Cypher query. Relationship types are allow-listed
 * so we never pull in noise. Results are LRU-cached in-memory per session.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Neo4jClient } from '@ekg/graph';

export interface NeighbourEdge {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly edge: string;
  readonly direction: 'out' | 'in';
}

export interface GraphExpander {
  expand(label: string, nodeId: string): Promise<readonly NeighbourEdge[]>;
}

const ALLOWED_REL_TYPES: readonly string[] = [
  'CALLS', 'IMPORTS', 'EXPORTS', 'USES', 'EXPOSES', 'CONTAINS',
  'DEPENDS_ON', 'READS_CONFIG', 'IMPLEMENTS', 'TESTS', 'DEFINES',
  'OWNS', 'HAS', 'DOCUMENTED_BY', 'PRODUCES', 'CONSUMES', 'QUERIES',
];

const DEFAULT_CAP = 5;
const CACHE_MAX = 200;

export interface Neo4jExpanderOptions {
  readonly cap?: number;
  readonly cacheMax?: number;
  readonly allowedRelTypes?: readonly string[];
}

export class Neo4jGraphExpander implements GraphExpander {
  private readonly client: Neo4jClient;
  private readonly cache: Map<string, readonly NeighbourEdge[]>;
  private readonly cap: number;
  private readonly cacheMax: number;
  private readonly relTypes: string;
  private readonly logger: Logger;

  constructor(client: Neo4jClient, opts: Neo4jExpanderOptions = {}) {
    this.client = client;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.cacheMax = opts.cacheMax ?? CACHE_MAX;
    const list = (opts.allowedRelTypes ?? ALLOWED_REL_TYPES).filter((t) => /^[A-Z_]+$/.test(t));
    if (list.length === 0) throw new Error('Neo4jGraphExpander needs at least one allow-listed rel type');
    this.relTypes = list.join('|');
    this.cache = new Map();
    this.logger = createLogger({ service: 'graph-expander' });
  }

  async expand(label: string, nodeId: string): Promise<readonly NeighbourEdge[]> {
    if (!/^[A-Za-z]+$/.test(label)) return [];
    const key = `${label}:${nodeId}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Touch for LRU.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const cypher = `
      MATCH (n:${label} {id: $id})
      CALL {
        WITH n
        MATCH (n)-[r:${this.relTypes}]->(m)
        RETURN type(r) AS edge, 'out' AS direction, m, r
        LIMIT ${this.cap}
        UNION
        WITH n
        MATCH (n)<-[r:${this.relTypes}]-(m)
        RETURN type(r) AS edge, 'in' AS direction, m, r
        LIMIT ${this.cap}
      }
      RETURN edge, direction,
             coalesce(m.id, '') AS mid,
             coalesce(labels(m)[0], '') AS mlabel,
             coalesce(m.name, '') AS mname
      LIMIT ${this.cap}
    `;

    try {
      const result = await this.client.executeRead(async (tx) => {
        const r = await tx.run(cypher, { id: nodeId });
        return r.records.map((rec) => ({
          edge: rec.get('edge') as string,
          direction: rec.get('direction') as 'out' | 'in',
          id: rec.get('mid') as string,
          label: rec.get('mlabel') as string,
          name: rec.get('mname') as string,
        }));
      });
      const neighbours: readonly NeighbourEdge[] = result;
      this.put(key, neighbours);
      return neighbours;
    } catch (err) {
      this.logger.warn({ label, nodeId, err: errMsg(err) }, 'Graph expansion failed');
      return [];
    }
  }

  private put(key: string, value: readonly NeighbourEdge[]): void {
    if (this.cache.size >= this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
