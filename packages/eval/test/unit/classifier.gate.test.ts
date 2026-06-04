/**
 * The merge-blocking gate, expressed as a test so it runs in `npm test` / CI
 * with zero infrastructure.
 *
 * It classifies all eval-set cases with the deterministic router classifier,
 * builds a classifier-only EvalRun, and asserts the committed baseline +
 * absolute floors hold. If an extractor/router change drops routing accuracy
 * below the floor (0.75) or regresses >5pp vs the frozen baseline, this test
 * fails and the merge is blocked — closing the "silent quality regression"
 * gap directly.
 *
 * To intentionally move the bar: re-run `ekg-eval gate --update-baseline`
 * and commit the new baseline.json in the same MR.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { classify } from '@ekg/router';
import { loadCasesFromFile } from '../../src/cases.loader.js';
import { evaluateGate } from '../../src/gate.js';
import { loadBaseline } from '../../src/baseline.js';
import type { EvalRun } from '../../src/eval.types.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalSet = resolve(here, '..', '..', 'eval-set');
const cases = loadCasesFromFile(resolve(evalSet, 'cases.json'));

function classifierOnlyRun(): EvalRun {
  const correct = cases.filter((c) => classify(c.question).class === c.expectedClass).length;
  return {
    runId: 'ci-classifier',
    startedAt: new Date(0).toISOString(),
    cases: cases.length,
    passed: 0,
    classifierAcc: Number((correct / cases.length).toFixed(4)),
    citationPrecision: 0,
    citationRecall: 0,
    faithfulness: 0,
  };
}

describe('eval gate (classifier-only, CI-enforced)', () => {
  it('has a substantial, labelled eval set (~200 cases, all with gold citations on non-negative cases)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    const withCitations = cases.filter((c) => c.goldCitations.length > 0).length;
    expect(withCitations / cases.length).toBeGreaterThan(0.9);
  });

  it('clears the absolute classifier-accuracy floor and the frozen baseline', () => {
    const run = classifierOnlyRun();
    const baseline = loadBaseline(resolve(evalSet, 'baseline.json'));
    expect(baseline, 'baseline.json must exist and parse').toBeTruthy();
    const result = evaluateGate(run, { baseline });
    if (!result.pass) {
      // Surface the exact failures in the test output for fast triage.
      throw new Error(`eval gate failed: ${result.failures.join('; ')}`);
    }
    expect(result.pass).toBe(true);
  });
});
