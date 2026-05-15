/**
 * Threshold guardrails for the eval gate.
 *
 * `enforce(run, t)` returns ok=true when every metric meets its floor, plus
 * a list of human-readable failure reasons when it doesn't. Thresholds are
 * resolved from `EvalThresholds` or environment variables so the same gate
 * works locally (`ekg-eval check`) and in CI.
 */

import type { EvalRun } from './eval.types.js';

export interface EvalThresholds {
  readonly minClassifierAcc: number;
  readonly minCitationPrecision: number;
  readonly minCitationRecall: number;
  readonly minPassRate: number;
}

export interface EnforcementResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly thresholds: EvalThresholds;
}

export const DEFAULT_THRESHOLDS: EvalThresholds = {
  minClassifierAcc: 0.85,
  minCitationPrecision: 0.30,
  minCitationRecall: 0.20,
  minPassRate: 0.50,
};

export function readThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): EvalThresholds {
  return {
    minClassifierAcc: numEnv(env['EKG_EVAL_MIN_CLASSIFIER_ACC'], DEFAULT_THRESHOLDS.minClassifierAcc),
    minCitationPrecision: numEnv(env['EKG_EVAL_MIN_CITATION_PRECISION'], DEFAULT_THRESHOLDS.minCitationPrecision),
    minCitationRecall: numEnv(env['EKG_EVAL_MIN_CITATION_RECALL'], DEFAULT_THRESHOLDS.minCitationRecall),
    minPassRate: numEnv(env['EKG_EVAL_MIN_PASS_RATE'], DEFAULT_THRESHOLDS.minPassRate),
  };
}

export function enforce(run: EvalRun, thresholds: EvalThresholds = DEFAULT_THRESHOLDS): EnforcementResult {
  const reasons: string[] = [];
  if (run.classifierAcc < thresholds.minClassifierAcc) {
    reasons.push(`classifierAcc ${run.classifierAcc.toFixed(4)} < ${thresholds.minClassifierAcc}`);
  }
  if (run.citationPrecision < thresholds.minCitationPrecision) {
    reasons.push(`citationPrecision ${run.citationPrecision.toFixed(4)} < ${thresholds.minCitationPrecision}`);
  }
  if (run.citationRecall < thresholds.minCitationRecall) {
    reasons.push(`citationRecall ${run.citationRecall.toFixed(4)} < ${thresholds.minCitationRecall}`);
  }
  const passRate = run.cases === 0 ? 0 : run.passed / run.cases;
  if (passRate < thresholds.minPassRate) {
    reasons.push(`passRate ${passRate.toFixed(4)} (${run.passed}/${run.cases}) < ${thresholds.minPassRate}`);
  }
  return { ok: reasons.length === 0, reasons, thresholds };
}

function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
