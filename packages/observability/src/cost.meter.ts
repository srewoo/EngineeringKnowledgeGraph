/**
 * Cost meter — pure cost estimation table per model.
 *
 * Prices in USD per 1K tokens, sourced from public pricing pages
 * (Anthropic / OpenAI / Voyage / Cohere). Update once per quarter.
 */

export type ProviderId = 'openai' | 'anthropic' | 'voyage' | 'cohere' | 'ollama' | 'unknown';

export interface PricePoint {
  readonly inputPer1k: number;
  readonly outputPer1k: number;
}

export const MODEL_COST_PER_1K_TOKENS: Readonly<Record<string, PricePoint>> = {
  // OpenAI
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'gpt-4-turbo': { inputPer1k: 0.01, outputPer1k: 0.03 },
  'text-embedding-3-small': { inputPer1k: 0.00002, outputPer1k: 0 },
  'text-embedding-3-large': { inputPer1k: 0.00013, outputPer1k: 0 },
  // Anthropic
  'claude-3-5-sonnet-20241022': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-3-5-haiku-20241022': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  'claude-3-opus-20240229': { inputPer1k: 0.015, outputPer1k: 0.075 },
  // Voyage
  'voyage-3': { inputPer1k: 0.00006, outputPer1k: 0 },
  'voyage-code-2': { inputPer1k: 0.00012, outputPer1k: 0 },
  // Cohere
  'rerank-english-v3.0': { inputPer1k: 0.001, outputPer1k: 0 },
  // Ollama (local — free)
  'ollama:default': { inputPer1k: 0, outputPer1k: 0 },
};

const FALLBACK: PricePoint = { inputPer1k: 0.005, outputPer1k: 0.015 };

export interface CostEstimate {
  readonly provider: ProviderId;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly fallback: boolean;
}

export function estimateCost(
  provider: ProviderId,
  model: string,
  tokensIn: number,
  tokensOut: number,
): CostEstimate {
  if (provider === 'ollama') {
    return { provider, model, tokensIn, tokensOut, costUsd: 0, fallback: false };
  }
  const price = MODEL_COST_PER_1K_TOKENS[model];
  const effective = price ?? FALLBACK;
  const costUsd =
    (tokensIn / 1000) * effective.inputPer1k +
    (tokensOut / 1000) * effective.outputPer1k;
  return {
    provider,
    model,
    tokensIn,
    tokensOut,
    costUsd: Number(costUsd.toFixed(6)),
    fallback: !price,
  };
}
