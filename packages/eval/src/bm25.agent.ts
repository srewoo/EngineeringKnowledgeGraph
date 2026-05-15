/**
 * BM25-backed retrieval-only "agent" used by the eval gate.
 *
 * No LLM. The agent runs the question through the SQLite FTS5 search index
 * and returns the top-K matching node IDs as citations. The synthetic
 * answer is the citation list rendered as plain text — enough for the
 * faithfulness metric to compute citation overlap without hallucinating.
 *
 * This keeps the CI gate hermetic (no external services, no LLM cost) while
 * still exercising the precision/recall/faithfulness pipeline end-to-end.
 */

import { existsSync } from 'node:fs';
import { SearchTextRepository } from '@ekg/storage';
import type { EvalAgent, EvalAgentResult } from './eval.runner.js';

export interface Bm25AgentOptions {
  readonly dbPath: string;
  readonly k?: number;
}

export class Bm25Agent implements EvalAgent {
  private readonly repo: SearchTextRepository;
  private readonly k: number;

  constructor(opts: Bm25AgentOptions) {
    this.repo = new SearchTextRepository(opts.dbPath);
    this.k = Math.max(1, opts.k ?? 5);
  }

  async ask(question: string): Promise<EvalAgentResult> {
    const hits = this.repo.searchBm25(question, { k: this.k });
    if (hits.length === 0) {
      return { status: 'refused', citations: [], refuseReason: 'no BM25 hits' };
    }
    const citations = hits.map((h) => h.nodeId);
    const answer = `Retrieved ${hits.length} matches: ${citations.map((c) => `[ref:${c}]`).join(' ')}`;
    return { status: 'ok', citations, answer };
  }

  close(): void { this.repo.close(); }
}

export function tryBuildBm25Agent(dbPath: string): Bm25Agent | null {
  if (!existsSync(dbPath)) return null;
  return new Bm25Agent({ dbPath });
}
