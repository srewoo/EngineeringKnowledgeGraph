/**
 * Traversal pruning policies.
 *
 * As we raise the depth caps for `analyzeImpact` (4 → 8) and `synthesizeFlow`
 * (10 → 15), the candidate set explodes. Pure depth caps are not enough — we
 * need *which* nodes to keep at each layer, biased toward signal over noise.
 *
 * Policies are pure deterministic: same input → same prune.
 *
 * ## Trade-offs
 *
 * - `byServiceBoundary` (default) — keep nodes with **low** fan-out first.
 *   Rationale: a function with 200 callers tells us little ("everyone uses
 *   it"), but a function with 2 callers crossing a service boundary is the
 *   real blast radius signal. Risk: we may miss a hub that genuinely should
 *   be reported. Mitigation: `maxNodesPerLayer` (default 200) is generous.
 *
 * - `byCallCount` — for `Function -[CALLS]-> Function` aggregations, weight by
 *   the number of distinct call sites. Useful when the question is "what
 *   *actually* uses this function" vs. "what *could* call it". Risk: hot
 *   utility functions dominate; combine with service-boundary in callers.
 *
 * - `byOwnership` — when an edge crosses a service boundary, weight nodes
 *   higher. Inverse of `byServiceBoundary`'s pruning bias — used when the
 *   question is explicitly "what other services touch this".
 */

export type PruningPolicy = 'service-boundary' | 'call-count' | 'ownership';

export const DEFAULT_PRUNING_POLICY: PruningPolicy = 'service-boundary';
export const DEFAULT_MAX_NODES_PER_LAYER = 200;

export interface Prunable {
  readonly id: string;
  readonly distance: number;
  readonly serviceName?: string;
  /** For call-count policy: # of distinct call sites observed. */
  readonly callSites?: number;
  /** For ownership policy: source service of the incoming edge, if any. */
  readonly fromService?: string;
}

export interface PruneOptions {
  readonly policy?: PruningPolicy;
  readonly maxNodesPerLayer?: number;
  /** Required for `ownership` — service that owns the seed/target. */
  readonly anchorService?: string;
}

/**
 * Bucket-by-distance and prune each layer independently. Returns the kept
 * subset preserving original order within each layer.
 */
export function prune<T extends Prunable>(rows: readonly T[], opts: PruneOptions = {}): readonly T[] {
  const policy = opts.policy ?? DEFAULT_PRUNING_POLICY;
  const cap = clampCap(opts.maxNodesPerLayer ?? DEFAULT_MAX_NODES_PER_LAYER);
  const layers = bucketByDistance(rows);
  const out: T[] = [];
  for (const layer of layers) {
    const ranked = rankLayer(layer, policy, opts.anchorService);
    out.push(...ranked.slice(0, cap));
  }
  return out;
}

function clampCap(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 5_000);
}

function bucketByDistance<T extends Prunable>(rows: readonly T[]): T[][] {
  const buckets = new Map<number, T[]>();
  for (const r of rows) {
    const d = Number.isFinite(r.distance) ? r.distance : 0;
    let b = buckets.get(d);
    if (!b) {
      b = [];
      buckets.set(d, b);
    }
    b.push(r);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

function rankLayer<T extends Prunable>(layer: readonly T[], policy: PruningPolicy, anchor: string | undefined): T[] {
  const indexed = layer.map((row, idx) => ({ row, idx, score: scoreFor(row, policy, anchor, layer) }));
  // Higher score wins; ties broken by original index (stable).
  indexed.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return indexed.map((x) => x.row);
}

function scoreFor<T extends Prunable>(row: T, policy: PruningPolicy, anchor: string | undefined, layer: readonly T[]): number {
  switch (policy) {
    case 'service-boundary':
      return scoreServiceBoundary(row, layer);
    case 'call-count':
      return scoreCallCount(row);
    case 'ownership':
      return scoreOwnership(row, anchor);
  }
}

/**
 * Inverse fan-out: nodes whose service appears rarely in this layer score
 * higher. A node from a service that has 50 other hits in this layer scores
 * lower than a singleton from an unusual service.
 */
function scoreServiceBoundary<T extends Prunable>(row: T, layer: readonly T[]): number {
  if (!row.serviceName) return 0.5;
  let count = 0;
  for (const r of layer) if (r.serviceName === row.serviceName) count += 1;
  if (count <= 0) return 1;
  return 1 / count;
}

function scoreCallCount<T extends Prunable>(row: T): number {
  return row.callSites ?? 0;
}

function scoreOwnership<T extends Prunable>(row: T, anchor: string | undefined): number {
  if (!anchor) return 0;
  if (row.serviceName && row.serviceName !== anchor) return 2;
  if (row.fromService && row.fromService !== anchor) return 1;
  return 0;
}
