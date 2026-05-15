/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Cormack et al., 2009 — "Reciprocal Rank Fusion outperforms Condorcet and
 * individual Rank Learning Methods". Combines multiple ranked lists by
 * summing 1 / (k + rank_in_list_i). `k=60` is the canonical default and
 * makes the fusion robust to score-scale differences between BM25 and
 * cosine similarity (we never need to normalise either).
 */

export const RRF_K = 60;

export interface RankedItem {
  /** Stable identifier — fusion key. */
  readonly id: string;
}

export interface FusedItem<T extends RankedItem> {
  readonly id: string;
  readonly score: number;
  readonly sources: ReadonlyArray<{ readonly source: string; readonly rank: number; readonly originalScore?: number }>;
  readonly item: T;
}

export interface NamedList<T extends RankedItem> {
  readonly source: string;
  readonly items: readonly T[];
  /** Optional original score per item (for diagnostics in the output). */
  readonly scores?: ReadonlyMap<string, number>;
}

/**
 * Fuse N ranked lists by RRF. Returns items sorted descending by fused score.
 * If the same id appears in multiple lists the latest item wins for the
 * `item` payload — pick whichever caller deems richer.
 */
export function reciprocalRankFusion<T extends RankedItem>(
  lists: readonly NamedList<T>[],
  k: number = RRF_K,
): readonly FusedItem<T>[] {
  if (k <= 0) throw new Error('RRF k must be positive');
  const acc = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      if (!item) continue;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const prev = acc.get(item.id);
      const sourceEntry = {
        source: list.source,
        rank,
        ...(list.scores?.has(item.id) ? { originalScore: list.scores.get(item.id) } : {}),
      };
      if (prev) {
        acc.set(item.id, {
          id: prev.id,
          score: prev.score + contribution,
          sources: [...prev.sources, sourceEntry],
          item,
        });
      } else {
        acc.set(item.id, {
          id: item.id,
          score: contribution,
          sources: [sourceEntry],
          item,
        });
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.score - a.score);
}
