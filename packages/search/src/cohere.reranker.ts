/**
 * Cohere Rerank — https://docs.cohere.com/reference/rerank
 * Uses raw fetch (no SDK). Default model: rerank-v3.5.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Reranker } from './reranker.interface.js';

export interface CohereRerankerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface CohereResult {
  readonly results: ReadonlyArray<{ readonly index: number; readonly relevance_score: number }>;
}

export class CohereReranker implements Reranker {
  readonly id = 'cohere' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: CohereRerankerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'rerank-v3.5';
    this.baseUrl = opts.baseUrl ?? 'https://api.cohere.com';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.logger = createLogger({ service: 'cohere-reranker' });
  }

  async rerank(query: string, docs: readonly string[]): Promise<readonly number[]> {
    if (docs.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v2/rerank`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: docs,
          top_n: docs.length,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await safeReadBody(res);
        throw new Error(`Cohere rerank failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as CohereResult;
      // Cohere returns results sorted by score; we need scores aligned to input order.
      const scores = new Array<number>(docs.length).fill(0);
      for (const r of json.results) {
        if (r.index >= 0 && r.index < scores.length) scores[r.index] = r.relevance_score;
      }
      return scores;
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'Cohere rerank failed; falling back to identity');
      return docs.map((_, i) => docs.length - i);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
