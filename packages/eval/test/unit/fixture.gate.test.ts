/**
 * Retrieval gate (CI-enforced, zero-infra).
 *
 * The classifier gate proves the router *dispatches* the right strategy. This
 * gate proves the strategy then *retrieves the right nodes*: it runs the
 * deterministic FixtureAgent over a committed synthetic graph
 * (fixture.graph.json) whose node ids are the gold citations of
 * fixture.cases.json, and asserts citation precision/recall clear a floor and
 * don't regress vs the frozen fixture baseline.
 *
 * This makes citation/recall gating live — not dormant — without needing
 * Neo4j or an LLM. If a retrieval strategy regresses (e.g. topology stops
 * walking dependents), recall drops and this test fails the build.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureGraph, FixtureAgent } from '../../src/index.js';
import { runEval } from '../../src/eval.runner.js';
import { loadCasesFromFile } from '../../src/cases.loader.js';
import { evaluateGate } from '../../src/gate.js';
import { loadBaseline } from '../../src/baseline.js';
import type { GraphFixture } from '../../src/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalSet = resolve(here, '..', '..', 'eval-set');

function loadGraph(): GraphFixture {
  return JSON.parse(readFileSync(resolve(evalSet, 'fixture.graph.json'), 'utf8')) as GraphFixture;
}

describe('retrieval gate (fixture agent, CI-enforced)', () => {
  it('every gold citation is a real node id in the fixture graph', () => {
    const graph = loadGraph();
    const ids = new Set(graph.nodes.map((n) => n.id));
    const cases = loadCasesFromFile(resolve(evalSet, 'fixture.cases.json'));
    expect(cases.length).toBeGreaterThanOrEqual(14);
    for (const c of cases) {
      for (const gold of c.goldCitations) {
        expect(ids.has(gold), `case ${c.id}: gold citation ${gold} missing from fixture graph`).toBe(true);
      }
    }
  });

  it('clears recall/precision floors and the frozen fixture baseline', async () => {
    const graph = loadGraph();
    const cases = loadCasesFromFile(resolve(evalSet, 'fixture.cases.json'));
    const agent = new FixtureAgent(new FixtureGraph(graph));
    const out = mkdtempSync(join(tmpdir(), 'ekg-fixture-gate-'));
    try {
      const { run } = await runEval(cases, agent, { outDir: out });
      const baseline = loadBaseline(resolve(evalSet, 'fixture.baseline.json'));
      expect(baseline, 'fixture.baseline.json must exist').toBeTruthy();
      // Faithfulness floor stays 0 — the FixtureAgent emits no prose, only
      // retrieved ids. This gate is about retrieval, not generation.
      const result = evaluateGate(run, {
        floors: { classifierAcc: 0.9, citationRecall: 0.9, citationPrecision: 0.7 },
        baseline,
      });
      if (!result.pass) {
        throw new Error(`fixture retrieval gate failed: ${result.failures.join('; ')}`);
      }
      expect(result.pass).toBe(true);
      expect(run.citationRecall).toBeGreaterThanOrEqual(0.9);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
