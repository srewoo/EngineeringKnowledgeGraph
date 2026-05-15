/**
 * Budget enforcement — pure function checked during agent loop.
 *
 * Three caps: total tokens, total USD spent, total tool calls. Any breach
 * returns `{ ok: false, reason }`. Caller is expected to refuse the answer
 * and log the violation.
 */

export interface BudgetLimits {
  readonly maxTokens: number;
  readonly maxUsd: number;
  readonly maxToolCalls: number;
}

export interface BudgetState {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly toolCalls: number;
}

export interface BudgetCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxTokens: 8000,
  maxUsd: 0.5,
  maxToolCalls: 5,
};

export function enforceBudget(state: BudgetState, limits: BudgetLimits): BudgetCheck {
  const totalTokens = state.tokensIn + state.tokensOut;
  if (totalTokens > limits.maxTokens) {
    return { ok: false, reason: `BUDGET: tokens=${totalTokens} > ${limits.maxTokens}` };
  }
  if (state.costUsd > limits.maxUsd) {
    return { ok: false, reason: `BUDGET: cost=$${state.costUsd.toFixed(4)} > $${limits.maxUsd}` };
  }
  if (state.toolCalls > limits.maxToolCalls) {
    return { ok: false, reason: `BUDGET: toolCalls=${state.toolCalls} > ${limits.maxToolCalls}` };
  }
  return { ok: true };
}

export function readBudgetEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const maxTokens = Number(env['EKG_AGENT_MAX_TOKENS'] ?? DEFAULT_BUDGET_LIMITS.maxTokens);
  const maxUsd = Number(env['EKG_AGENT_MAX_USD_PER_QUERY'] ?? DEFAULT_BUDGET_LIMITS.maxUsd);
  const maxToolCalls = Number(env['EKG_AGENT_MAX_TOOL_CALLS'] ?? DEFAULT_BUDGET_LIMITS.maxToolCalls);
  return {
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_BUDGET_LIMITS.maxTokens,
    maxUsd: Number.isFinite(maxUsd) && maxUsd >= 0 ? maxUsd : DEFAULT_BUDGET_LIMITS.maxUsd,
    maxToolCalls: Number.isFinite(maxToolCalls) && maxToolCalls > 0 ? maxToolCalls : DEFAULT_BUDGET_LIMITS.maxToolCalls,
  };
}
