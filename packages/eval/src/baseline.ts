/**
 * Baseline harness — write / read a frozen `EvalRun` and compare a new run
 * against it for regression detection.
 *
 * Why this exists: without a baseline, every eval run is a number in
 * isolation. Quality drift only becomes visible weeks later, after the
 * tests-as-graph-of-truth feedback loop has already passed several PRs.
 *
 * Usage:
 *   - `saveBaseline(run, path)` after a known-good run becomes the new SLA.
 *   - `loadBaseline(path)` returns the prior `EvalRun` or undefined.
 *   - `compareToBaseline(current, baseline, options)` returns a structured
 *     verdict + diffs. Defaults are conservative:
 *       * classifierAcc drop > 5 percentage points → regression
 *       * citationRecall drop > 5 pp → regression
 *       * faithfulness drop > 5 pp → regression
 *       * answerRelevance drop > 7 pp → regression (judge-noisier)
 *
 * Pure / deterministic. No I/O when caller passes the values directly;
 * `loadBaseline` / `saveBaseline` are the only file-touching helpers and
 * fail soft on missing/invalid files (returns undefined / throws on save).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { EvalRun } from './eval.types.js';

export interface BaselineThresholds {
  /** Max acceptable drop in classifierAcc, in absolute percentage points. */
  readonly classifierAcc?: number;
  readonly citationPrecision?: number;
  readonly citationRecall?: number;
  readonly faithfulness?: number;
  readonly answerRelevance?: number;
}

const DEFAULT_THRESHOLDS: Required<BaselineThresholds> = {
  classifierAcc: 0.05,
  citationPrecision: 0.05,
  citationRecall: 0.05,
  faithfulness: 0.05,
  answerRelevance: 0.07,
};

export interface MetricDelta {
  readonly metric: keyof BaselineThresholds;
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
  readonly threshold: number;
  readonly regression: boolean;
}

export interface BaselineComparison {
  readonly verdict: 'pass' | 'regression' | 'no-baseline';
  readonly baselineRunId?: string;
  readonly currentRunId: string;
  readonly deltas: readonly MetricDelta[];
  readonly regressions: readonly MetricDelta[];
}

/**
 * Pure: compare two EvalRun aggregates and surface regressions.
 *
 * `answerRelevance` is optional on EvalRun (judge runs are opt-in). When
 * only one side has it, we skip that metric rather than penalising the
 * other side.
 */
export function compareToBaseline(
  current: EvalRun,
  baseline: EvalRun | undefined,
  options: { readonly thresholds?: BaselineThresholds } = {},
): BaselineComparison {
  if (!baseline) {
    return {
      verdict: 'no-baseline',
      currentRunId: current.runId,
      deltas: [],
      regressions: [],
    };
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const deltas: MetricDelta[] = [];

  const push = (metric: keyof BaselineThresholds, base: number | undefined, curr: number | undefined): void => {
    if (typeof base !== 'number' || typeof curr !== 'number') return;
    const delta = round(curr - base);
    const threshold = thresholds[metric];
    const regression = delta < -threshold;
    deltas.push({ metric, baseline: base, current: curr, delta, threshold, regression });
  };

  push('classifierAcc',      baseline.classifierAcc,     current.classifierAcc);
  push('citationPrecision',  baseline.citationPrecision, current.citationPrecision);
  push('citationRecall',     baseline.citationRecall,    current.citationRecall);
  push('faithfulness',       baseline.faithfulness,      current.faithfulness);
  push('answerRelevance',    baseline.answerRelevance,   current.answerRelevance);

  const regressions = deltas.filter((d) => d.regression);
  return {
    verdict: regressions.length > 0 ? 'regression' : 'pass',
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    deltas,
    regressions,
  };
}

/**
 * Format a comparison as a short, copy-pastable line per metric for CI logs.
 * Caller decides whether to print on pass; regressions should always show.
 */
export function formatComparison(cmp: BaselineComparison): string {
  if (cmp.verdict === 'no-baseline') {
    return `no baseline available (run ${cmp.currentRunId})`;
  }
  const head = `${cmp.verdict.toUpperCase()} | baseline ${cmp.baselineRunId} → current ${cmp.currentRunId}`;
  const lines = cmp.deltas.map((d) => {
    const arrow = d.delta >= 0 ? '↑' : '↓';
    const flag = d.regression ? ' REGRESSION' : '';
    return `  ${d.metric}: ${d.baseline.toFixed(4)} → ${d.current.toFixed(4)}  ${arrow}${Math.abs(d.delta).toFixed(4)} (threshold ${d.threshold.toFixed(2)})${flag}`;
  });
  return [head, ...lines].join('\n');
}

const baselineSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  cases: z.number(),
  passed: z.number(),
  classifierAcc: z.number(),
  citationPrecision: z.number(),
  citationRecall: z.number(),
  faithfulness: z.number(),
  answerRelevance: z.number().optional(),
});

/** Read a baseline file. Returns undefined on missing or unparseable file. */
export function loadBaseline(path: string): EvalRun | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return baselineSchema.parse(raw) as EvalRun;
  } catch {
    return undefined;
  }
}

/** Atomically write a baseline file. Creates parent dirs. Throws on I/O errors. */
export function saveBaseline(run: EvalRun, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(run, null, 2);
  writeFileSync(path, payload, 'utf8');
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
