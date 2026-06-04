/**
 * Tests for the baseline comparison harness.
 *
 * The pure path (`compareToBaseline`, `formatComparison`) is exhaustively
 * covered here. The I/O path (`load`/`saveBaseline`) is touched with a
 * temp file for a single round-trip test — the heavy lifting is delegated
 * to Node's `fs` and Zod, which we trust.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareToBaseline,
  formatComparison,
  loadBaseline,
  saveBaseline,
} from '../../src/baseline.js';
import type { EvalRun } from '../../src/eval.types.js';

function run(over: Partial<EvalRun>): EvalRun {
  return {
    runId: 'r-1',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    cases: 100,
    passed: 80,
    classifierAcc: 0.9,
    citationPrecision: 0.7,
    citationRecall: 0.8,
    faithfulness: 0.85,
    ...over,
  };
}

describe('compareToBaseline', () => {
  it('returns no-baseline when baseline is undefined', () => {
    const cmp = compareToBaseline(run({}), undefined);
    expect(cmp.verdict).toBe('no-baseline');
    expect(cmp.deltas).toEqual([]);
    expect(cmp.regressions).toEqual([]);
  });

  it('passes when all metrics are within threshold (improved counts as pass)', () => {
    const baseline = run({ classifierAcc: 0.85, citationRecall: 0.75 });
    const current  = run({ classifierAcc: 0.90, citationRecall: 0.80, runId: 'r-2' });
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.verdict).toBe('pass');
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.deltas.find((d) => d.metric === 'classifierAcc')!.delta).toBeCloseTo(0.05);
  });

  it('flags a regression when a metric drops below threshold', () => {
    const baseline = run({ classifierAcc: 0.95 });
    const current  = run({ classifierAcc: 0.85, runId: 'r-2' }); // -0.10 vs default 0.05 threshold
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.verdict).toBe('regression');
    expect(cmp.regressions.map((r) => r.metric)).toContain('classifierAcc');
  });

  it('respects custom thresholds (tighter)', () => {
    const baseline = run({ classifierAcc: 0.90 });
    const current  = run({ classifierAcc: 0.88, runId: 'r-2' }); // -0.02
    const lax = compareToBaseline(current, baseline);            // 0.05 default
    const tight = compareToBaseline(current, baseline, { thresholds: { classifierAcc: 0.01 } });
    expect(lax.verdict).toBe('pass');
    expect(tight.verdict).toBe('regression');
  });

  it('skips answerRelevance when either side lacks the metric', () => {
    const baseline = run({});
    const current  = run({ runId: 'r-2', answerRelevance: 0.5 });
    const cmp = compareToBaseline(current, baseline);
    expect(cmp.deltas.find((d) => d.metric === 'answerRelevance')).toBeUndefined();
  });

  it('reports each metric with baseline, current, delta, and threshold', () => {
    const baseline = run({});
    const current  = run({ runId: 'r-2' });
    const cmp = compareToBaseline(current, baseline);
    for (const d of cmp.deltas) {
      expect(typeof d.baseline).toBe('number');
      expect(typeof d.current).toBe('number');
      expect(typeof d.delta).toBe('number');
      expect(typeof d.threshold).toBe('number');
      expect(typeof d.regression).toBe('boolean');
    }
  });
});

describe('formatComparison', () => {
  it('returns a no-baseline placeholder line', () => {
    const cmp = compareToBaseline(run({}), undefined);
    expect(formatComparison(cmp)).toMatch(/no baseline/);
  });

  it('marks regression lines with REGRESSION', () => {
    const baseline = run({ classifierAcc: 0.95 });
    const current  = run({ classifierAcc: 0.7, runId: 'r-2' });
    const out = formatComparison(compareToBaseline(current, baseline));
    expect(out).toMatch(/REGRESSION/);
  });
});

describe('loadBaseline / saveBaseline round trip', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ekg-baseline-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns undefined when the file does not exist', () => {
    expect(loadBaseline(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('round-trips a valid EvalRun', () => {
    const original = run({ runId: 'r-baseline' });
    const path = join(dir, 'baseline.json');
    saveBaseline(original, path);
    const reloaded = loadBaseline(path);
    expect(reloaded?.runId).toBe('r-baseline');
    expect(reloaded?.classifierAcc).toBe(original.classifierAcc);
  });
});
