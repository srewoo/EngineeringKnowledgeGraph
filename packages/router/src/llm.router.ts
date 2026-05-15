/**
 * LLM router factory + opt-in fallback orchestrator.
 *
 * Env (mirrors embeddings/factory.ts):
 *   EKG_ROUTER_ENABLED  = 'true' | 'false' (default false)
 *   EKG_ROUTER_PROVIDER = 'openai' | 'anthropic' | 'ollama' (default ollama)
 *   EKG_ROUTER_MODEL    = optional model override
 *
 * Used by plan.executor only when rule-first confidence < threshold AND
 * EKG_ROUTER_ENABLED='true'. Never invoked by default.
 */

import { z } from 'zod';
import type { LlmRouter } from './llm.router.interface.js';
import { OpenAIRouter } from './openai.router.js';
import { AnthropicRouter } from './anthropic.router.js';
import { OllamaRouter } from './ollama.router.js';

export const ROUTER_LLM_THRESHOLD = 0.4;

const envSchema = z.object({
  EKG_ROUTER_ENABLED: z.enum(['true', 'false']).default('false'),
  EKG_ROUTER_PROVIDER: z.enum(['openai', 'anthropic', 'ollama']).default('ollama'),
  EKG_ROUTER_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().optional(),
});

export interface RouterEnv {
  readonly enabled: boolean;
  readonly provider: 'openai' | 'anthropic' | 'ollama';
  readonly model?: string;
}

export function readRouterEnv(env: NodeJS.ProcessEnv = process.env): RouterEnv {
  const parsed = envSchema.parse({
    EKG_ROUTER_ENABLED: env['EKG_ROUTER_ENABLED'],
    EKG_ROUTER_PROVIDER: env['EKG_ROUTER_PROVIDER'],
    EKG_ROUTER_MODEL: env['EKG_ROUTER_MODEL'],
    OPENAI_API_KEY: env['OPENAI_API_KEY'],
    ANTHROPIC_API_KEY: env['ANTHROPIC_API_KEY'],
    OLLAMA_URL: env['OLLAMA_URL'],
  });
  return {
    enabled: parsed.EKG_ROUTER_ENABLED === 'true',
    provider: parsed.EKG_ROUTER_PROVIDER,
    ...(parsed.EKG_ROUTER_MODEL ? { model: parsed.EKG_ROUTER_MODEL } : {}),
  };
}

export function getLlmRouter(env: NodeJS.ProcessEnv = process.env): LlmRouter | undefined {
  const cfg = readRouterEnv(env);
  if (!cfg.enabled) return undefined;
  switch (cfg.provider) {
    case 'openai': {
      const apiKey = env['OPENAI_API_KEY'];
      if (!apiKey) throw new Error('EKG_ROUTER_PROVIDER=openai requires OPENAI_API_KEY');
      return new OpenAIRouter({ apiKey, ...(cfg.model ? { model: cfg.model } : {}) });
    }
    case 'anthropic': {
      const apiKey = env['ANTHROPIC_API_KEY'];
      if (!apiKey) throw new Error('EKG_ROUTER_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return new AnthropicRouter({ apiKey, ...(cfg.model ? { model: cfg.model } : {}) });
    }
    case 'ollama':
    default:
      return new OllamaRouter({
        ...(env['OLLAMA_URL'] ? { baseUrl: env['OLLAMA_URL'] } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
      });
  }
}
