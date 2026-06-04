import { describe, it, expect } from 'vitest';
import { evaluateGate, DEFAULT_FLOORS } from '../../src/gate.js';
import type { EvalRun } from '../../src/eval.types.js';

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    runId: 'r1',
    startedAt: '2026-01-01T00:00:00.000Z',
    cases: 100,
    passed: 50,
    classifierAcc: 0.8,
    citationPrecision: 0.6,
    citationRecall: 0.6,
    faithfulness: 0.7,
    ...overrides,
  };
}

describe('evaluateGate', () => {
  it('passes when all floors are cleared and no baseline', () => {
    const r = evaluateGate(run(), { floors: { classifierAcc: 0.75 } });
    expect(r.pass).toBe(true);
    expect(r.failures).toHaveLength(0);
    expect(r.baseline.verdict).toBe('no-baseline');
  });

  it('fails when classifier accuracy is below the floor', () => {
    const r = evaluateGate(run({ classifierAcc: 0.5 }), { floors: { classifierAcc: 0.75 } });
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.includes('classifierAcc'))).toBe(true);
  });

  it('uses DEFAULT_FLOORS when none supplied (classifierAcc 0.75)', () => {
    expect(DEFAULT_FLOORS.classifierAcc).toBe(0.75);
    expect(evaluateGate(run({ classifierAcc: 0.74 })).pass).toBe(false);
    expect(evaluateGate(run({ classifierAcc: 0.76 })).pass).toBe(true);
  });

  it('flags a regression vs baseline beyond the threshold', () => {
    const baseline = run({ runId: 'base', classifierAcc: 0.9 });
    const current = run({ runId: 'cur', classifierAcc: 0.8 }); // −0.10 > 0.05 default
    const r = evaluateGate(current, { baseline });
    expect(r.baseline.verdict).toBe('regression');
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.includes('regressed'))).toBe(true);
  });

  it('passes a within-threshold drop vs baseline', () => {
    const baseline = run({ runId: 'base', classifierAcc: 0.82 });
    const current = run({ runId: 'cur', classifierAcc: 0.8 }); // −0.02 < 0.05
    const r = evaluateGate(current, { baseline });
    expect(r.baseline.verdict).toBe('pass');
    expect(r.pass).toBe(true);
  });

  it('honours raised citation floors (fixture-agent mode)', () => {
    const r = evaluateGate(run({ citationRecall: 0.3 }), { floors: { citationRecall: 0.5 } });
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.includes('citationRecall'))).toBe(true);
  });
});
