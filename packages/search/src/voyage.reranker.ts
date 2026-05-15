/**
 * Voyage Rerank — https://docs.voyageai.com/reference/reranker-api
 * Default model: rerank-2.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { Reranker } from './reranker.interface.js';

export interface VoyageRerankerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface VoyageResult {
  readonly data: ReadonlyArray<{ readonly index: number; readonly relevance_score: number }>;
}

export class VoyageReranker implements Reranker {
  readonly id = 'voyage' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: VoyageRerankerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'rerank-2';
    this.baseUrl = opts.baseUrl ?? 'https://api.voyageai.com';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.logger = createLogger({ service: 'voyage-reranker' });
  }

  async rerank(query: string, docs: readonly string[]): Promise<readonly number[]> {
    if (docs.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/rerank`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: docs,
          top_k: docs.length,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await safeReadBody(res);
        throw new Error(`Voyage rerank failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as VoyageResult;
      const scores = new Array<number>(docs.length).fill(0);
      for (const r of json.data) {
        if (r.index >= 0 && r.index < scores.length) scores[r.index] = r.relevance_score;
      }
      return scores;
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'Voyage rerank failed; falling back to identity');
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
