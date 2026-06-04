#!/usr/bin/env node
/**
 * ekg-eval CLI.
 *
 * Usage:
 *   ekg-eval run  [--cases <path>] [--limit N] [--no-agent] [--fixture <path>] [--out <dir>]
 *   ekg-eval gate [--cases <path>] [--baseline <path>] [--fixture <path>]
 *                 [--min-classifier-acc X] [--min-recall X] [--min-faithfulness X]
 *                 [--update-baseline]
 *
 * `run` loads eval cases, scores them, and prints a one-line summary.
 * `gate` does the same then applies absolute floors + baseline-regression
 * checks and **exits non-zero on failure** so CI can block a merge.
 *
 * Agent selection (both commands):
 *   --no-agent            → classifier-only (no infra; citation metrics = 0)
 *   --fixture <path>      → deterministic FixtureAgent over an in-memory graph
 *                           JSON (enables citation/recall gating with no Neo4j)
 *   (default)             → classifier-only, same as --no-agent
 *
 * The default is classifier-only because that is the one signal that runs in
 * CI with zero infrastructure and is fully deterministic — it catches the
 * "extractor/router change silently regressed routing" failure mode directly.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createLogger } from '@ekg/shared';
import { loadCasesFromFile } from './cases.loader.js';
import { runEval } from './eval.runner.js';
import type { EvalAgent } from './eval.runner.js';
import { FixtureGraph, type GraphFixture } from './fixtures.js';
import { FixtureAgent } from './fixture.agent.js';
import { evaluateGate, formatGate, type GateFloors } from './gate.js';
import { loadBaseline, saveBaseline } from './baseline.js';

interface ParsedArgs {
  readonly command: string;
  readonly casesPath?: string;
  readonly limit?: number;
  readonly noAgent: boolean;
  readonly fixturePath?: string;
  readonly out?: string;
  readonly baselinePath?: string;
  readonly updateBaseline: boolean;
  readonly floors: GateFloors;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'run';
  let casesPath: string | undefined;
  let limit: number | undefined;
  let noAgent = false;
  let fixturePath: string | undefined;
  let out: string | undefined;
  let baselinePath: string | undefined;
  let updateBaseline = false;
  const floors: { classifierAcc?: number; citationRecall?: number; faithfulness?: number } = {};
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--cases') { casesPath = args[i + 1]; i += 1; }
    else if (a === '--limit') { limit = Number(args[i + 1]); i += 1; }
    else if (a === '--no-agent') { noAgent = true; }
    else if (a === '--fixture') { fixturePath = args[i + 1]; i += 1; }
    else if (a === '--out') { out = args[i + 1]; i += 1; }
    else if (a === '--baseline') { baselinePath = args[i + 1]; i += 1; }
    else if (a === '--update-baseline') { updateBaseline = true; }
    else if (a === '--min-classifier-acc') { floors.classifierAcc = Number(args[i + 1]); i += 1; }
    else if (a === '--min-recall') { floors.citationRecall = Number(args[i + 1]); i += 1; }
    else if (a === '--min-faithfulness') { floors.faithfulness = Number(args[i + 1]); i += 1; }
  }
  return {
    command,
    ...(casesPath ? { casesPath } : {}),
    ...(typeof limit === 'number' && Number.isFinite(limit) ? { limit } : {}),
    noAgent,
    ...(fixturePath ? { fixturePath } : {}),
    ...(out ? { out } : {}),
    ...(baselinePath ? { baselinePath } : {}),
    updateBaseline,
    floors,
  };
}

function evalSetDir(): string {
  // dist/cli.js -> ../eval-set
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval-set');
}

function defaultCasesPath(): string {
  return join(evalSetDir(), 'cases.json');
}

function defaultBaselinePath(): string {
  return join(evalSetDir(), 'baseline.json');
}

/** Build a FixtureAgent from a graph-fixture JSON file, or null on failure. */
function buildFixtureAgent(fixturePath: string, logger: ReturnType<typeof createLogger>): EvalAgent | null {
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GraphFixture;
    return new FixtureAgent(new FixtureGraph(fixture));
  } catch (err) {
    logger.warn({ err, fixturePath }, 'failed to load fixture; falling back to classifier-only');
    return null;
  }
}

function summariseRun(run: { runId: string; cases: number; passed: number; classifierAcc: number; citationPrecision: number; citationRecall: number; faithfulness: number; answerRelevance?: number }): string {
  return [
    `runId=${run.runId}`,
    `cases=${run.cases}`,
    `passed=${run.passed}`,
    `classifierAcc=${run.classifierAcc}`,
    `precision=${run.citationPrecision}`,
    `recall=${run.citationRecall}`,
    `faithfulness=${run.faithfulness}`,
    run.answerRelevance !== undefined ? `fluency=${run.answerRelevance}` : '',
  ].filter((s) => s.length > 0).join(' ');
}

async function main(): Promise<void> {
  const logger = createLogger({ service: 'ekg-eval' });
  const args = parseArgs(process.argv);

  if (args.command !== 'run' && args.command !== 'gate') {
    process.stderr.write(`unknown command: ${args.command}\nusage: ekg-eval (run|gate) [...]\n`);
    process.exit(2);
  }

  const casesPath = args.casesPath ?? defaultCasesPath();
  const cases = loadCasesFromFile(casesPath);
  logger.info({ casesPath, count: cases.length }, 'loaded eval cases');

  const agent: EvalAgent | null = args.fixturePath
    ? buildFixtureAgent(args.fixturePath, logger)
    : args.noAgent
      ? null
      : null;

  const opts = {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.out ? { outDir: args.out } : {}),
  };
  const { run } = await runEval(cases, agent, opts);
  process.stdout.write(`${summariseRun(run)}\n`);

  if (args.command === 'run') return;

  // gate
  const baselinePath = args.baselinePath ?? defaultBaselinePath();
  const baseline = loadBaseline(baselinePath);
  const result = evaluateGate(run, { floors: args.floors, baseline });
  process.stdout.write(`${formatGate(result)}\n`);

  if (args.updateBaseline) {
    saveBaseline(run, baselinePath);
    process.stdout.write(`baseline updated → ${baselinePath}\n`);
    return;
  }

  if (!result.pass) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ekg-eval failed: ${msg}\n`);
  process.exit(1);
});
