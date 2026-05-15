/**
 * Ollama embeddings provider — local, free, laptop-friendly default.
 *
 * Ollama's /api/embeddings endpoint accepts ONE prompt per request, so we
 * loop sequentially. For laptop-scale ingestion this is fine; concurrency
 * here can saturate the local model thread.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { EmbeddingProvider } from './provider.interface.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export interface OllamaProviderOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
}

interface OllamaResponse {
  readonly embedding: readonly number[];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    this.model = opts.model ?? 'nomic-embed-text';
    this.dimensions = opts.dimensions ?? 768;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'ollama-embeddings' });
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await this.embedOneWithRetry(text));
    }
    return out;
  }

  private async embedOneWithRetry(text: string): Promise<number[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.embedOne(text);
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES - 1) break;
        const delay = BASE_BACKOFF_MS * 2 ** attempt;
        this.logger.warn({ attempt: attempt + 1, delay }, 'Ollama embeddings retrying');
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async embedOne(text: string): Promise<number[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Ollama embeddings ${res.status}: ${body}`);
    }
    const json = (await res.json()) as OllamaResponse;
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new Error('Ollama embeddings: empty embedding in response');
    }
    return Array.from(json.embedding);
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return '<no-body>'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
