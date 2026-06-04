/**
 * Synthetic-graph fixtures for end-to-end eval (Phase F → 8.0).
 *
 * Until we have a CI-friendly way to ingest a real repo into Neo4j, the
 * eval set measures *classification* accuracy. That tells us whether the
 * router would dispatch the right strategy on a question, but says nothing
 * about whether retrieval would return the right rows.
 *
 * Fixtures close the gap: a hand-built graph (nodes + edges) lives in
 * memory; a `FixtureGraph` exposes the small set of queries the eval
 * runner exercises; per-case `expectedHits` declare which fixture nodes
 * the system should retrieve. The runner then computes
 * **retrievalPrecision / recall** alongside the existing classification
 * metric.
 *
 * Pure / deterministic. No I/O. Pluggable: callers compose fixtures from
 * tiny scenarios (e.g. one service + two APIs + one shared DB) per
 * question, or one big fixture shared across cases.
 */

export interface FixtureNode {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface FixtureEdge {
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface GraphFixture {
  readonly nodes: readonly FixtureNode[];
  readonly edges: readonly FixtureEdge[];
}

/**
 * In-memory queryable fixture. The query surface mirrors what
 * `executePlan` actually exercises (topology, ownership, schema by name,
 * config-key substring, MR project lookup) — kept minimal to avoid
 * recreating the full Cypher engine. Add methods as the runner gains
 * surface area.
 */
export class FixtureGraph {
  private readonly nodesById = new Map<string, FixtureNode>();
  private readonly nodesByLabel = new Map<string, FixtureNode[]>();
  private readonly nodesByName = new Map<string, FixtureNode[]>();
  private readonly edgesBySource = new Map<string, FixtureEdge[]>();
  private readonly edgesByTarget = new Map<string, FixtureEdge[]>();

  constructor(fixture: GraphFixture) {
    for (const n of fixture.nodes) {
      this.nodesById.set(n.id, n);
      this.pushIndex(this.nodesByLabel, n.label, n);
      this.pushIndex(this.nodesByName, n.name.toLowerCase(), n);
    }
    for (const e of fixture.edges) {
      this.pushIndex(this.edgesBySource, e.sourceId, e);
      this.pushIndex(this.edgesByTarget, e.targetId, e);
    }
  }

  /** Look up a node by id. */
  get(id: string): FixtureNode | undefined { return this.nodesById.get(id); }

  /** Nodes of a given label (Service, API, ...). */
  byLabel(label: string): readonly FixtureNode[] {
    return this.nodesByLabel.get(label) ?? [];
  }

  /** Case-insensitive exact match on the `name` property. */
  byName(name: string): readonly FixtureNode[] {
    return this.nodesByName.get(name.toLowerCase()) ?? [];
  }

  /**
   * "Depends-on" traversal: returns ids of nodes reachable from `sourceId`
   * via DEPENDS_ON | USES | CALLS edges up to a depth. Used to score the
   * topology question class.
   */
  dependsOn(sourceId: string, maxDepth = 3): readonly string[] {
    return this.bfs(sourceId, new Set(['DEPENDS_ON', 'USES', 'CALLS']), 'forward', maxDepth);
  }

  /** Reverse traversal — "who depends on me" via the same edge types. */
  dependents(targetId: string, maxDepth = 3): readonly string[] {
    return this.bfs(targetId, new Set(['DEPENDS_ON', 'USES', 'CALLS']), 'reverse', maxDepth);
  }

  /** Owners / Teams attached to a Service via OWNS / OWNED_BY. */
  owners(serviceId: string): readonly string[] {
    const out: string[] = [];
    for (const e of this.edgesByTarget.get(serviceId) ?? []) {
      if (e.type === 'OWNS') out.push(e.sourceId);
    }
    for (const e of this.edgesBySource.get(serviceId) ?? []) {
      if (e.type === 'OWNED_BY') out.push(e.targetId);
    }
    return out;
  }

  /** APIs exposed by a Service. */
  exposes(serviceId: string): readonly string[] {
    return (this.edgesBySource.get(serviceId) ?? [])
      .filter((e) => e.type === 'EXPOSES')
      .map((e) => e.targetId);
  }

  /** ConfigKeys read by a Service or matching a substring on `key` property. */
  configsFor(serviceId: string | undefined, substring: string | undefined): readonly string[] {
    const out = new Set<string>();
    if (serviceId) {
      for (const e of this.edgesBySource.get(serviceId) ?? []) {
        if (e.type === 'READS_CONFIG') out.add(e.targetId);
      }
    }
    if (substring && substring.length > 0) {
      const sub = substring.toLowerCase();
      for (const n of this.nodesByLabel.get('ConfigKey') ?? []) {
        const key = String((n.properties as { key?: unknown }).key ?? '').toLowerCase();
        if (key.includes(sub)) out.add(n.id);
      }
    }
    return [...out];
  }

  /** MRs whose projectPath / author / title contain a token. */
  findMrs(token: string): readonly string[] {
    const tok = token.toLowerCase();
    const out: string[] = [];
    for (const n of this.nodesByLabel.get('MR') ?? []) {
      const p = n.properties as { projectPath?: unknown; author?: unknown; title?: unknown };
      if (
        String(p.projectPath ?? '').toLowerCase().includes(tok)
        || String(p.author ?? '').toLowerCase() === tok
        || String(p.title ?? '').toLowerCase().includes(tok)
      ) out.push(n.id);
    }
    return out;
  }

  /** Total nodes — handy for sanity checks. */
  size(): number { return this.nodesById.size; }

  // ---- helpers ----

  private pushIndex<K, V>(map: Map<K, V[]>, k: K, v: V): void {
    let list = map.get(k);
    if (!list) { list = []; map.set(k, list); }
    list.push(v);
  }

  private bfs(
    start: string,
    types: ReadonlySet<string>,
    direction: 'forward' | 'reverse',
    maxDepth: number,
  ): string[] {
    const seen = new Set<string>([start]);
    const out: string[] = [];
    let frontier: string[] = [start];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = direction === 'forward'
          ? (this.edgesBySource.get(id) ?? [])
          : (this.edgesByTarget.get(id) ?? []);
        for (const e of edges) {
          if (!types.has(e.type)) continue;
          const neighbour = direction === 'forward' ? e.targetId : e.sourceId;
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          out.push(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    return out;
  }
}
