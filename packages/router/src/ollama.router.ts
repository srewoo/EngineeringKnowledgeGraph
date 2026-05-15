/**
 * Ollama-backed router. Local, free, default for laptop deployments.
 * Hits /api/chat with format=json so the model returns parseable JSON.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { LlmRouter, LlmClassification } from './llm.router.interface.js';
import {
  ROUTER_SYSTEM_PROMPT,
  COMPLETION_TOKEN_CAP,
  llmClassificationSchema,
  parseLlmJson,
} from './llm.router.prompt.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface OllamaRouterOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ChatResponse {
  readonly message?: { readonly content?: string };
}

export class OllamaRouter implements LlmRouter {
  readonly id = 'ollama' as const;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OllamaRouterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    this.model = opts.model ?? 'llama3.1:8b';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'ollama-router' });
  }

  async classify(question: string): Promise<LlmClassification> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: 'json',
        options: { num_predict: COMPLETION_TOKEN_CAP, temperature: 0 },
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Ollama router ${res.status}: ${body}`);
    }
    const json = (await res.json()) as ChatResponse;
    const content = json.message?.content ?? '';
    const parsed = llmClassificationSchema.parse(parseLlmJson(content));
    this.logger.debug({ class: parsed.class, confidence: parsed.confidence }, 'Ollama router classified');
    return parsed;
  }
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
