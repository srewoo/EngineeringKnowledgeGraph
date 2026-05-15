import { describe, it, expect } from 'vitest';
import { estimateCost, MODEL_COST_PER_1K_TOKENS } from '../../src/cost.meter.js';

describe('estimateCost', () => {
  it('computes Sonnet pricing on 1K tokens in / 1K out', () => {
    const c = estimateCost('anthropic', 'claude-3-5-sonnet-20241022', 1000, 1000);
    // 1*0.003 + 1*0.015 = 0.018
    expect(c.costUsd).toBeCloseTo(0.018, 6);
    expect(c.fallback).toBe(false);
  });

  it('returns 0 for ollama (local) regardless of model', () => {
    const c = estimateCost('ollama', 'whatever:latest', 5000, 5000);
    expect(c.costUsd).toBe(0);
    expect(c.fallback).toBe(false);
  });

  it('falls back when model is unknown', () => {
    const c = estimateCost('openai', 'gpt-9-future-model', 1000, 1000);
    expect(c.fallback).toBe(true);
    expect(c.costUsd).toBeGreaterThan(0);
  });

  it('handles zero tokens', () => {
    const c = estimateCost('openai', 'gpt-4o', 0, 0);
    expect(c.costUsd).toBe(0);
  });

  it('embedding models charge only on input', () => {
    const c = estimateCost('openai', 'text-embedding-3-small', 10000, 0);
    expect(c.costUsd).toBeCloseTo(0.0002, 6);
  });

  it('table is non-empty and well-formed', () => {
    expect(Object.keys(MODEL_COST_PER_1K_TOKENS).length).toBeGreaterThan(5);
    for (const v of Object.values(MODEL_COST_PER_1K_TOKENS)) {
      expect(v.inputPer1k).toBeGreaterThanOrEqual(0);
      expect(v.outputPer1k).toBeGreaterThanOrEqual(0);
    }
  });
});
