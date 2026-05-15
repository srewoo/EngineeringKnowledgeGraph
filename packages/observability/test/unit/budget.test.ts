import { describe, it, expect } from 'vitest';
import { enforceBudget, readBudgetEnv, DEFAULT_BUDGET_LIMITS } from '../../src/budget.js';

describe('enforceBudget', () => {
  const limits = { maxTokens: 1000, maxUsd: 0.10, maxToolCalls: 3 };

  it('allows within limits', () => {
    expect(enforceBudget({ tokensIn: 100, tokensOut: 100, costUsd: 0.01, toolCalls: 1 }, limits).ok).toBe(true);
  });

  it('rejects when tokens exceed cap', () => {
    const r = enforceBudget({ tokensIn: 600, tokensOut: 600, costUsd: 0, toolCalls: 0 }, limits);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tokens');
  });

  it('rejects when cost exceeds cap', () => {
    const r = enforceBudget({ tokensIn: 0, tokensOut: 0, costUsd: 0.99, toolCalls: 0 }, limits);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cost');
  });

  it('rejects when tool-call count exceeds cap', () => {
    const r = enforceBudget({ tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 99 }, limits);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('toolCalls');
  });

  it('exact-equality is allowed (boundary)', () => {
    const r = enforceBudget({ tokensIn: 500, tokensOut: 500, costUsd: 0.10, toolCalls: 3 }, limits);
    expect(r.ok).toBe(true);
  });
});

describe('readBudgetEnv', () => {
  it('returns defaults on empty env', () => {
    expect(readBudgetEnv({})).toEqual(DEFAULT_BUDGET_LIMITS);
  });

  it('parses valid env values', () => {
    const r = readBudgetEnv({
      EKG_AGENT_MAX_TOKENS: '2000',
      EKG_AGENT_MAX_USD_PER_QUERY: '0.25',
      EKG_AGENT_MAX_TOOL_CALLS: '8',
    });
    expect(r).toEqual({ maxTokens: 2000, maxUsd: 0.25, maxToolCalls: 8 });
  });

  it('falls back to defaults on garbage', () => {
    const r = readBudgetEnv({ EKG_AGENT_MAX_TOKENS: 'not-a-number' });
    expect(r.maxTokens).toBe(DEFAULT_BUDGET_LIMITS.maxTokens);
  });
});
