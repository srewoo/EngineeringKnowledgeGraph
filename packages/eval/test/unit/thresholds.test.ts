import { describe, it, expect } from 'vitest';
import { enforce, readThresholdsFromEnv, DEFAULT_THRESHOLDS } from '../../src/thresholds.js';
import type { EvalRun } from '../../src/eval.types.js';

const PASSING: EvalRun = {
  runId: 'r', startedAt: 'now',
  cases: 10, passed: 6,
  classifierAcc: 0.9, citationPrecision: 0.5, citationRecall: 0.4, faithfulness: 0.8,
};

describe('enforce', () => {
  it('passes with defaults when all metrics meet floor', () => {
    const r = enforce(PASSING);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails when classifierAcc below floor', () => {
    const r = enforce({ ...PASSING, classifierAcc: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('classifierAcc');
  });

  it('fails when pass rate below floor', () => {
    const r = enforce({ ...PASSING, passed: 1 });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('passRate'))).toBe(true);
  });

  it('readThresholdsFromEnv returns defaults when env empty', () => {
    expect(readThresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it('readThresholdsFromEnv reads numeric env overrides', () => {
    const t = readThresholdsFromEnv({
      EKG_EVAL_MIN_CLASSIFIER_ACC: '0.5',
      EKG_EVAL_MIN_CITATION_PRECISION: '0.1',
      EKG_EVAL_MIN_CITATION_RECALL: '0.05',
      EKG_EVAL_MIN_PASS_RATE: '0.2',
    });
    expect(t).toEqual({
      minClassifierAcc: 0.5,
      minCitationPrecision: 0.1,
      minCitationRecall: 0.05,
      minPassRate: 0.2,
    });
  });
});
