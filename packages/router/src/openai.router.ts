/**
 * OpenAI-backed router. Uses raw fetch against /v1/chat/completions —
 * no SDK. Hard-caps completion at COMPLETION_TOKEN_CAP tokens.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { LlmRouter, LlmClassification } from './llm.router.interface.js';
import {
  ROUTER_SYSTEM_PROMPT,
  COMPLETION_TOKEN_CAP,
  llmClassificationSchema,
  parseLlmJson,
} from './llm.router.prompt.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface OpenAIRouterOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
}

export class OpenAIRouter implements LlmRouter {
  readonly id = 'openai' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OpenAIRouterOptions) {
    if (!opts.apiKey) throw new Error('OpenAIRouter: apiKey required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'openai-router' });
  }

  async classify(question: string): Promise<LlmClassification> {
    const res = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: COMPLETION_TOKEN_CAP,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`OpenAI router ${res.status}: ${body}`);
    }
    const json = (await res.json()) as ChatResponse;
    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = llmClassificationSchema.parse(parseLlmJson(content));
    this.logger.debug({ class: parsed.class, confidence: parsed.confidence }, 'OpenAI router classified');
    return parsed;
  }
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
