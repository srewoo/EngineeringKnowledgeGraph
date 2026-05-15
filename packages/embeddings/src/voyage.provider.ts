/**
 * Voyage AI embeddings provider.
 *
 * Posts to /v1/embeddings. Same retry/backoff shape as the OpenAI provider.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { EmbeddingProvider } from './provider.interface.js';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export interface VoyageProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
}

interface VoyageResponse {
  readonly data: ReadonlyArray<{ readonly embedding: readonly number[] }>;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: VoyageProviderOptions) {
    if (!opts.apiKey) {
      throw new Error('VoyageEmbeddingProvider: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'voyage-3';
    this.dimensions = opts.dimensions ?? 1024;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'voyage-embeddings' });
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
      const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
      out.push(...(await this.callWithRetry(batch)));
    }
    return out;
  }

  private async callWithRetry(batch: readonly string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.callOnce(batch);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof Error && /\b(429|5\d{2})\b/.test(err.message);
        if (!retryable || attempt === MAX_RETRIES - 1) break;
        const delay = BASE_BACKOFF_MS * 2 ** attempt;
        this.logger.warn({ attempt: attempt + 1, delay }, 'Voyage embeddings retrying');
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async callOnce(batch: readonly string[]): Promise<number[][]> {
    const res = await this.fetchImpl(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: batch }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Voyage embeddings ${res.status}: ${body}`);
    }
    const json = (await res.json()) as VoyageResponse;
    if (!json.data || json.data.length !== batch.length) {
      throw new Error(`Voyage embeddings: expected ${batch.length} vectors, got ${json.data?.length ?? 0}`);
    }
    return json.data.map((d) => Array.from(d.embedding));
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return '<no-body>'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
