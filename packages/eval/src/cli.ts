#!/usr/bin/env node
/**
 * ekg-eval CLI.
 *
 * Usage:
 *   ekg-eval run [--cases <path>] [--limit N] [--no-agent] [--out <dir>]
 *   ekg-eval check <summary.json> [--no-agent]
 *
 * `run` loads cases, runs the agent (or retrieval-only with `--no-agent`),
 * writes per-case JSONL to `<out>/<runId>/cases.jsonl` and a roll-up to
 * `<out>/<runId>/summary.json`, then prints a one-line summary.
 *
 * `check` loads a summary.json from a previous run and exits non-zero when
 * any threshold is violated. Same gate used by CI and locally.
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createLogger } from '@ekg/shared';
import { loadCasesFromFile } from './cases.loader.js';
import { runEval } from './eval.runner.js';
import type { EvalAgent, EvalAgentResult } from './eval.runner.js';
import type { EvalRun } from './eval.types.js';
import { enforce, readThresholdsFromEnv } from './thresholds.js';
import { tryBuildBm25Agent } from './bm25.agent.js';

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly casesPath?: string;
  readonly limit?: number;
  readonly noAgent: boolean;
  readonly out?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'run';
  const positional: string[] = [];
  let casesPath: string | undefined;
  let limit: number | undefined;
  let noAgent = false;
  let out: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--cases') { casesPath = args[i + 1]; i += 1; }
    else if (a === '--limit') { limit = Number(args[i + 1]); i += 1; }
    else if (a === '--no-agent') { noAgent = true; }
    else if (a === '--out') { out = args[i + 1]; i += 1; }
    else if (a && !a.startsWith('--')) { positional.push(a); }
  }
  return {
    command, positional,
    ...(casesPath ? { casesPath } : {}),
    ...(typeof limit === 'number' && Number.isFinite(limit) ? { limit } : {}),
    noAgent,
    ...(out ? { out } : {}),
  };
}

function defaultCasesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval-set', 'cases.json');
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const logger = createLogger({ service: 'ekg-eval' });
  const casesPath = args.casesPath ?? defaultCasesPath();
  const cases = loadCasesFromFile(casesPath);
  logger.info({ casesPath, count: cases.length }, 'loaded eval cases');

  const agent: EvalAgent | null = args.noAgent
    ? buildBm25AgentOrNull(logger)
    : buildAgentOrNull(logger);

  const opts = {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.out ? { outDir: join(args.out, `eval-${Date.now()}`) } : {}),
  };
  const { run } = await runEval(cases, agent, opts);

  // Write summary.json next to per-case JSONL so `ekg-eval check` can find it.
  const summaryPath = opts.outDir ? join(opts.outDir, 'summary.json') : undefined;
  if (summaryPath) {
    writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    logger.info({ summaryPath }, 'wrote summary.json');
  }

  process.stdout.write(`${formatSummary(run)}\n`);
  if (summaryPath) process.stdout.write(`summary=${summaryPath}\n`);
}

function cmdCheck(args: ParsedArgs): void {
  const summaryPath = args.positional[0];
  if (!summaryPath) {
    process.stderr.write('usage: ekg-eval check <summary.json>\n');
    process.exit(2);
  }
  const raw = readFileSync(summaryPath, 'utf8');
  const run = JSON.parse(raw) as EvalRun;
  const thresholds = readThresholdsFromEnv();
  const result = enforce(run, thresholds);

  process.stdout.write(`${formatSummary(run)}\n`);
  process.stdout.write(`thresholds=${JSON.stringify(thresholds)}\n`);
  if (!result.ok) {
    for (const r of result.reasons) process.stderr.write(`gate-failed: ${r}\n`);
    process.exit(1);
  }
  process.stdout.write('gate-passed\n');
}

function formatSummary(run: EvalRun): string {
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
  const args = parseArgs(process.argv);
  if (args.command === 'run') return cmdRun(args);
  if (args.command === 'check') return cmdCheck(args);
  process.stderr.write(`unknown command: ${args.command}\nusage: ekg-eval (run|check) ...\n`);
  process.exit(2);
}

function buildBm25AgentOrNull(logger: ReturnType<typeof createLogger>): EvalAgent | null {
  const dataDir = resolve(process.env['DATA_DIR'] ?? join(process.cwd(), 'data'));
  const dbPath = join(dataDir, 'ekg-search.db');
  const agent = tryBuildBm25Agent(dbPath);
  if (!agent) {
    logger.warn({ dbPath }, 'BM25 search index not found; running classifier-only');
    return null;
  }
  logger.info({ dbPath }, 'using BM25 retrieval-only agent');
  return agent;
}

function buildAgentOrNull(logger: ReturnType<typeof createLogger>): EvalAgent | null {
  // The CLI does not assemble the full agent stack — that requires Neo4j +
  // search infra wired up. Surface a clear message and fall back to
  // retrieval-only mode so the harness remains useful in CI without infra.
  logger.warn('CLI agent wiring is not bundled; running retrieval-only. Use the MCP tool eval_run for full agent runs.');
  void evalAgentSatisfiesType;
  return null;
}

const evalAgentSatisfiesType: EvalAgentResult = {
  status: 'refused',
  citations: [],
  refuseReason: '',
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ekg-eval failed: ${msg}\n`);
  process.exit(1);
});
