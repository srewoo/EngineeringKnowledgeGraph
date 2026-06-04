/**
 * Phase F: composite plan decomposition tests.
 *
 * Covers the classifier → selectComposite → shouldUseComposite chain
 * (the pure pieces). The executor itself runs Cypher / hybrid search and
 * is tested under existing plan.executor.test.ts; the composite executor
 * is a thin parallel-fan-out wrapper around it, so we test orchestration
 * via shouldUseCompositePlan + selectCompositeStrategy here.
 */

import { describe, it, expect } from 'vitest';
import { classify } from '../../src/question.classifier.js';
import { selectCompositeStrategy } from '../../src/strategy.selector.js';
import { shouldUseCompositePlan } from '../../src/plan.executor.js';

describe('classify — secondaryClasses', () => {
  it('returns empty secondaryClasses for clean single-class question', () => {
    const r = classify('Who owns the billing module?');
    expect(r.class).toBe('ownership');
    expect(r.secondaryClasses).toEqual([]);
  });

  it('returns secondaryClasses for compound question (code + runtime)', () => {
    // "in production" → runtime; "implements" → code
    const r = classify('In production, where is JWT validation implemented and how slow is it?');
    expect(['runtime', 'code']).toContain(r.class);
    expect(r.secondaryClasses.length).toBeGreaterThan(0);
    // Both classes should be reachable from primary + secondary.
    const all = [r.class, ...r.secondaryClasses];
    expect(all).toContain('runtime');
    expect(all).toContain('code');
  });

  it('caps secondaryClasses at 3 even if more classes hit', () => {
    // Construct a maximally noisy query — many specific keywords.
    const r = classify('Which endpoint, kafka topic, owner, and schema for billing in prod?');
    expect(r.secondaryClasses.length).toBeLessThanOrEqual(3);
  });
});

describe('selectCompositeStrategy', () => {
  it('builds composite with primary first then deduped secondaries', () => {
    const composite = selectCompositeStrategy('runtime', ['code', 'topology']);
    expect(composite.kind).toBe('composite');
    expect(composite.subStrategies).toHaveLength(3);
    expect(composite.subStrategies[0]!.class).toBe('runtime');
    expect(composite.subStrategies[1]!.class).toBe('code');
    expect(composite.subStrategies[2]!.class).toBe('topology');
  });

  it('dedupes when primary appears in secondaries', () => {
    const composite = selectCompositeStrategy('runtime', ['runtime', 'code']);
    expect(composite.subStrategies).toHaveLength(2);
    expect(composite.subStrategies.map((s) => s.class)).toEqual(['runtime', 'code']);
  });

  it('attaches the underlying strategy for each class', () => {
    const composite = selectCompositeStrategy('topology', ['runtime']);
    expect(composite.subStrategies[0]!.strategy.kind).toBe('graph-only');
    expect(composite.subStrategies[0]!.strategy.cypher).toBe('topology');
    expect(composite.subStrategies[1]!.strategy.cypher).toBe('runtime');
  });
});

describe('shouldUseCompositePlan', () => {
  it('returns false when there are no secondary classes', () => {
    expect(shouldUseCompositePlan('runtime', [], 0.95)).toBe(false);
  });

  it('returns false for unknown primary', () => {
    expect(shouldUseCompositePlan('unknown', ['code'], 0.3)).toBe(false);
  });

  it('returns true when the primary classification is ambiguous (confidence ≤ 0.5)', () => {
    expect(shouldUseCompositePlan('runtime', ['code'], 0.3)).toBe(true);
  });

  it('returns true when 2+ secondary classes fired, regardless of confidence', () => {
    expect(shouldUseCompositePlan('topology', ['runtime', 'code'], 0.95)).toBe(true);
  });

  it('returns false with one clean secondary class but high primary confidence', () => {
    expect(shouldUseCompositePlan('runtime', ['ownership'], 0.95)).toBe(false);
  });
});
