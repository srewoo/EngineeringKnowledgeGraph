/**
 * Agent LLM provider factory. Mirrors `@ekg/embeddings` and `@ekg/router`
 * env-var conventions.
 *
 * Env:
 *   EKG_AGENT_ENABLED   = 'true' | 'false' (default false). Enforced by callers.
 *   EKG_AGENT_PROVIDER  = 'openai' | 'anthropic' | 'ollama' (default 'ollama')
 *   EKG_AGENT_MODEL     = optional model override
 *   EKG_AGENT_MAX_TOKENS= optional, total token budget per question (default 8000)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_URL  — provider creds
 */

import { z } from 'zod';
import type { LlmProvider } from './provider.interface.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OllamaProvider } from './ollama.provider.js';

export const AGENT_DEFAULT_MAX_TOKENS = 8000;
export const AGENT_DEFAULT_TOOL_ITERATIONS = 5;

const envSchema = z.object({
  EKG_AGENT_ENABLED: z.enum(['true', 'false']).default('false'),
  EKG_AGENT_PROVIDER: z.enum(['openai', 'anthropic', 'ollama']).default('ollama'),
  EKG_AGENT_MODEL: z.string().optional(),
  EKG_AGENT_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().optional(),
});

export interface AgentEnv {
  readonly enabled: boolean;
  readonly provider: 'openai' | 'anthropic' | 'ollama';
  readonly model?: string;
  readonly maxTokens: number;
}

export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const parsed = envSchema.parse({
    EKG_AGENT_ENABLED: env['EKG_AGENT_ENABLED'],
    EKG_AGENT_PROVIDER: env['EKG_AGENT_PROVIDER'],
    EKG_AGENT_MODEL: env['EKG_AGENT_MODEL'],
    EKG_AGENT_MAX_TOKENS: env['EKG_AGENT_MAX_TOKENS'],
    OPENAI_API_KEY: env['OPENAI_API_KEY'],
    ANTHROPIC_API_KEY: env['ANTHROPIC_API_KEY'],
    OLLAMA_URL: env['OLLAMA_URL'],
  });
  return {
    enabled: parsed.EKG_AGENT_ENABLED === 'true',
    provider: parsed.EKG_AGENT_PROVIDER,
    ...(parsed.EKG_AGENT_MODEL ? { model: parsed.EKG_AGENT_MODEL } : {}),
    maxTokens: parsed.EKG_AGENT_MAX_TOKENS ?? AGENT_DEFAULT_MAX_TOKENS,
  };
}

export function getAgentProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const cfg = readAgentEnv(env);
  switch (cfg.provider) {
    case 'openai': {
      const apiKey = env['OPENAI_API_KEY'];
      if (!apiKey) throw new Error('EKG_AGENT_PROVIDER=openai requires OPENAI_API_KEY');
      return new OpenAIProvider({ apiKey, ...(cfg.model ? { model: cfg.model } : {}) });
    }
    case 'anthropic': {
      const apiKey = env['ANTHROPIC_API_KEY'];
      if (!apiKey) throw new Error('EKG_AGENT_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return new AnthropicProvider({ apiKey, ...(cfg.model ? { model: cfg.model } : {}) });
    }
    case 'ollama':
    default:
      return new OllamaProvider({
        ...(env['OLLAMA_URL'] ? { baseUrl: env['OLLAMA_URL'] } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
      });
  }
}
