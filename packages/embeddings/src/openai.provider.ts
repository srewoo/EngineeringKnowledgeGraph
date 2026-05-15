/**
 * OpenAI embeddings provider.
 *
 * Posts to /v1/embeddings. Batches inputs at OPENAI_BATCH_SIZE per request.
 * Retries 3× with exponential backoff on 429 and 5xx.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { EmbeddingProvider } from './provider.interface.js';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const OPENAI_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
}

interface OpenAIResponse {
  readonly data: ReadonlyArray<{ readonly embedding: readonly number[] }>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) {
      throw new Error('OpenAIEmbeddingProvider: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'openai-embeddings' });
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
      const vectors = await this.callWithRetry(batch);
      out.push(...vectors);
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
        const retryable = err instanceof RetryableHttpError;
        if (!retryable || attempt === MAX_RETRIES - 1) break;
        const delay = BASE_BACKOFF_MS * 2 ** attempt;
        this.logger.warn({ attempt: attempt + 1, delay, status: (err as RetryableHttpError).status }, 'OpenAI embeddings retrying');
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async callOnce(batch: readonly string[]): Promise<number[][]> {
    const res = await this.fetchImpl(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: batch }),
    });

    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableHttpError(res.status, `OpenAI embeddings ${res.status}: ${body}`);
      }
      throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    if (!json.data || json.data.length !== batch.length) {
      throw new Error(`OpenAI embeddings: expected ${batch.length} vectors, got ${json.data?.length ?? 0}`);
    }
    return json.data.map((d) => Array.from(d.embedding));
  }
}

class RetryableHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RetryableHttpError';
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return '<no-body>'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
