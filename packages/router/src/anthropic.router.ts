/**
 * Anthropic-backed router. Uses raw fetch against /v1/messages — no SDK.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { LlmRouter, LlmClassification } from './llm.router.interface.js';
import {
  ROUTER_SYSTEM_PROMPT,
  COMPLETION_TOKEN_CAP,
  llmClassificationSchema,
  parseLlmJson,
} from './llm.router.prompt.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicRouterOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export class AnthropicRouter implements LlmRouter {
  readonly id = 'anthropic' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: AnthropicRouterOptions) {
    if (!opts.apiKey) throw new Error('AnthropicRouter: apiKey required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'claude-3-5-haiku-latest';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'anthropic-router' });
  }

  async classify(question: string): Promise<LlmClassification> {
    const res = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: COMPLETION_TOKEN_CAP,
        temperature: 0,
        system: ROUTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Anthropic router ${res.status}: ${body}`);
    }
    const json = (await res.json()) as MessagesResponse;
    const text = json.content?.find((c) => c.type === 'text')?.text ?? '';
    const parsed = llmClassificationSchema.parse(parseLlmJson(text));
    this.logger.debug({ class: parsed.class, confidence: parsed.confidence }, 'Anthropic router classified');
    return parsed;
  }
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
