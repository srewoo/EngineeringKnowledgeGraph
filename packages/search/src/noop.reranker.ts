import type { Reranker } from './reranker.interface.js';

/** Returns descending pseudo-scores in the input order — preserves fusion ranking. */
export class NoopReranker implements Reranker {
  readonly id = 'noop' as const;
  async rerank(_query: string, docs: readonly string[]): Promise<readonly number[]> {
    const n = docs.length;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = n - i;
    return out;
  }
}
