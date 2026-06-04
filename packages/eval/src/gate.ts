/**
 * Eval gate (Item 2) — the merge-blocking verdict.
 *
 * `baseline.ts` answers "did this run regress vs. the last known-good run?"
 * (relative). A gate also needs absolute floors: "classifier accuracy must
 * never drop below X regardless of baseline" — so a slowly-eroding baseline
 * can't ratchet quality down one acceptable-looking drop at a time.
 *
 * `evaluateGate` combines both: a run PASSES only if it clears every absolute
 * floor AND shows no regression beyond the baseline thresholds. The CLI maps
 * a failing verdict to a non-zero exit code so CI blocks the merge.
 *
 * Pure / deterministic. No I/O.
 */

import type { EvalRun } from './eval.types.js';
import {
  compareToBaseline,
  type BaselineComparison,
  type BaselineThresholds,
} from './baseline.js';

export interface GateFloors {
  /** Absolute minimum classifier accuracy (0..1). */
  readonly classifierAcc?: number;
  readonly citationPrecision?: number;
  readonly citationRecall?: number;
  readonly faithfulness?: number;
}

/**
 * Conservative defaults. classifierAcc floor sits a little below the current
 * measured baseline (≈0.80 on the 191-case set) so normal noise doesn't trip
 * it, but a real classifier/extractor regression does. Citation/faithfulness
 * floors default to 0 (off) because they only carry signal when the run used
 * a real retrieval agent — the CLI raises them when `--fixture` is supplied.
 */
export const DEFAULT_FLOORS: Required<GateFloors> = {
  classifierAcc: 0.75,
  citationPrecision: 0,
  citationRecall: 0,
  faithfulness: 0,
};

export interface GateResult {
  readonly pass: boolean;
  /** Human-readable failure lines; empty when `pass` is true. */
  readonly failures: readonly string[];
  readonly floorChecks: readonly {
    readonly metric: keyof GateFloors;
    readonly value: number;
    readonly floor: number;
    readonly ok: boolean;
  }[];
  readonly baseline: BaselineComparison;
}

export interface EvaluateGateOptions {
  readonly floors?: GateFloors;
  readonly baseline?: EvalRun | undefined;
  readonly baselineThresholds?: BaselineThresholds;
}

const METRIC_KEYS: readonly (keyof GateFloors)[] = [
  'classifierAcc', 'citationPrecision', 'citationRecall', 'faithfulness',
];

function metricValue(run: EvalRun, key: keyof GateFloors): number {
  switch (key) {
    case 'classifierAcc': return run.classifierAcc;
    case 'citationPrecision': return run.citationPrecision;
    case 'citationRecall': return run.citationRecall;
    case 'faithfulness': return run.faithfulness;
  }
}

export function evaluateGate(run: EvalRun, opts: EvaluateGateOptions = {}): GateResult {
  const floors = { ...DEFAULT_FLOORS, ...opts.floors };
  const failures: string[] = [];

  const floorChecks = METRIC_KEYS.map((metric) => {
    const value = metricValue(run, metric);
    const floor = floors[metric];
    const ok = value >= floor;
    if (!ok) {
      failures.push(`${metric} ${value.toFixed(4)} below floor ${floor.toFixed(2)}`);
    }
    return { metric, value, floor, ok };
  });

  const baseline = compareToBaseline(run, opts.baseline, {
    ...(opts.baselineThresholds ? { thresholds: opts.baselineThresholds } : {}),
  });
  if (baseline.verdict === 'regression') {
    for (const r of baseline.regressions) {
      failures.push(`${r.metric} regressed ${r.delta.toFixed(4)} vs baseline (threshold ${r.threshold.toFixed(2)})`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    floorChecks,
    baseline,
  };
}

/** Format a gate verdict for CI logs. */
export function formatGate(result: GateResult): string {
  const head = result.pass ? 'EVAL GATE: PASS' : 'EVAL GATE: FAIL';
  const lines = result.floorChecks.map((c) => {
    const mark = c.ok ? 'ok' : 'FAIL';
    return `  [${mark}] ${c.metric}: ${c.value.toFixed(4)} (floor ${c.floor.toFixed(2)})`;
  });
  if (result.failures.length > 0) {
    lines.push('  failures:');
    for (const f of result.failures) lines.push(`    - ${f}`);
  }
  return [head, ...lines].join('\n');
}
