#!/usr/bin/env node
/**
 * ekg-eval CLI.
 *
 * Usage:
 *   ekg-eval run [--cases <path>] [--limit N] [--no-agent] [--out <dir>]
 *
 * Loads eval cases, runs the agent (or retrieval-only with --no-agent), and
 * prints a one-line summary. Per-case JSONL traces are written to <out>/cases.jsonl.
 *
 * NOTE: when --no-agent is passed (or building an agent fails) the runner
 * scores classifier accuracy only — citation/faithfulness will be zero.
 */

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createLogger } from '@ekg/shared';
import { loadCasesFromFile } from './cases.loader.js';
import { runEval } from './eval.runner.js';
import type { EvalAgent, EvalAgentResult } from './eval.runner.js';

interface ParsedArgs {
  readonly command: string;
  readonly casesPath?: string;
  readonly limit?: number;
  readonly noAgent: boolean;
  readonly out?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'run';
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
  }
  return {
    command,
    ...(casesPath ? { casesPath } : {}),
    ...(typeof limit === 'number' && Number.isFinite(limit) ? { limit } : {}),
    noAgent,
    ...(out ? { out } : {}),
  };
}

function defaultCasesPath(): string {
  // Resolve relative to the dist/ output: dist/cli.js -> ../eval-set/cases.json
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval-set', 'cases.json');
}

async function main(): Promise<void> {
  const logger = createLogger({ service: 'ekg-eval' });
  const args = parseArgs(process.argv);

  if (args.command !== 'run') {
    process.stderr.write(`unknown command: ${args.command}\nusage: ekg-eval run [--cases path] [--limit N] [--no-agent] [--out dir]\n`);
    process.exit(2);
  }

  const casesPath = args.casesPath ?? defaultCasesPath();
  const cases = loadCasesFromFile(casesPath);
  logger.info({ casesPath, count: cases.length }, 'loaded eval cases');

  const agent: EvalAgent | null = args.noAgent ? null : buildAgentOrNull(logger);

  const opts = {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.out ? { outDir: args.out } : {}),
  };
  const { run } = await runEval(cases, agent, opts);

  const summary = [
    `runId=${run.runId}`,
    `cases=${run.cases}`,
    `passed=${run.passed}`,
    `classifierAcc=${run.classifierAcc}`,
    `precision=${run.citationPrecision}`,
    `recall=${run.citationRecall}`,
    `faithfulness=${run.faithfulness}`,
    run.answerRelevance !== undefined ? `fluency=${run.answerRelevance}` : '',
  ].filter((s) => s.length > 0).join(' ');

  process.stdout.write(`${summary}\n`);
}

function buildAgentOrNull(logger: ReturnType<typeof createLogger>): EvalAgent | null {
  // The CLI does not assemble the full agent stack — that requires Neo4j +
  // search infra wired up. Surface a clear message and fall back to
  // retrieval-only mode so the harness remains useful in CI without infra.
  logger.warn('CLI agent wiring is not bundled; running retrieval-only. Use the MCP tool eval_run for full agent runs.');
  void evalAgentSatisfiesType; // silence unused
  return null;
}

// Compile-time assertion that the EvalAgentResult shape stays stable.
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
