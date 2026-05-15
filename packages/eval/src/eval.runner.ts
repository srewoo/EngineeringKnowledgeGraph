/**
 * Eval runner — runs cases against an Agent (or retrieval-only) and aggregates
 * metrics. Writes per-case JSONL traces under data/eval/<runId>/cases.jsonl.
 *
 * The runner is agent-shaped behind an `EvalAgent` interface so tests can
 * mock it without pulling in the full LLM stack.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '@ekg/shared';
import { classify, type QuestionClass as RouterClass } from '@ekg/router';
import type { EvalCase, EvalRun, PerCaseResult, QuestionClass } from './eval.types.js';
import { citationOverlap, faithfulness, average } from './metrics.js';

export interface EvalAgentResult {
  readonly status: 'ok' | 'refused' | 'error';
  readonly answer?: string;
  readonly citations: readonly string[];
  readonly refuseReason?: string;
  readonly errorMessage?: string;
}

export interface EvalAgent {
  ask(question: string): Promise<EvalAgentResult>;
}

export interface RunEvalOptions {
  readonly outDir?: string;
  readonly limit?: number;
  /** Optional fluency judge — never used for faithfulness. */
  readonly judge?: (q: string, a: string) => Promise<number>;
}

export async function runEval(
  cases: readonly EvalCase[],
  agent: EvalAgent | null,
  opts: RunEvalOptions = {},
): Promise<{ run: EvalRun; perCase: readonly PerCaseResult[] }> {
  const logger: Logger = createLogger({ service: 'eval-runner' });
  const runId = `eval-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir ?? join(process.cwd(), 'data', 'eval', runId);
  mkdirSync(outDir, { recursive: true });
  const tracePath = join(outDir, 'cases.jsonl');

  const limited = typeof opts.limit === 'number' ? cases.slice(0, opts.limit) : cases;
  const perCase: PerCaseResult[] = [];

  for (const c of limited) {
    const t0 = Date.now();
    const result = await scoreCase(c, agent, opts.judge);
    const latencyMs = Date.now() - t0;
    const row: PerCaseResult = { ...result, latencyMs };
    perCase.push(row);
    appendFileSync(tracePath, `${JSON.stringify(row)}\n`, 'utf8');
  }

  const run = aggregate(runId, startedAt, perCase);
  logger.info({
    runId,
    cases: run.cases,
    classifierAcc: run.classifierAcc,
    citationPrecision: run.citationPrecision,
    citationRecall: run.citationRecall,
    faithfulness: run.faithfulness,
    answerRelevance: run.answerRelevance,
  }, 'eval.run.completed');

  return { run, perCase };
}

async function scoreCase(
  c: EvalCase,
  agent: EvalAgent | null,
  judge?: (q: string, a: string) => Promise<number>,
): Promise<Omit<PerCaseResult, 'latencyMs'>> {
  const cls = classify(c.question);
  const predictedClass = cls.class as QuestionClass;
  const classCorrect = predictedClass === c.expectedClass;

  if (!agent) {
    // Retrieval-only score skeleton. Caller may add retrieval-only paths later.
    return {
      id: c.id,
      question: c.question,
      expectedClass: c.expectedClass,
      predictedClass,
      classCorrect,
      retrievedCitations: [],
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: c.goldCitations.length,
      precision: 0,
      recall: c.goldCitations.length === 0 ? 1 : 0,
      faithfulness: 0,
      status: 'refused',
      refuseReason: 'agent disabled (retrieval-only mode)',
    };
  }

  let agentResult: EvalAgentResult;
  try {
    agentResult = await agent.ask(c.question);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: c.id,
      question: c.question,
      expectedClass: c.expectedClass,
      predictedClass,
      classCorrect,
      retrievedCitations: [],
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: c.goldCitations.length,
      precision: 0,
      recall: 0,
      faithfulness: 0,
      status: 'error',
      errorMessage: msg,
    };
  }

  const overlap = citationOverlap(agentResult.citations, c.goldCitations);
  const faith = agentResult.answer
    ? faithfulness(agentResult.answer, agentResult.citations)
    : 0;

  let judgeFluency: number | undefined;
  if (judge && agentResult.answer && agentResult.status === 'ok') {
    try {
      judgeFluency = await judge(c.question, agentResult.answer);
    } catch {
      judgeFluency = undefined;
    }
  }

  const base: Omit<PerCaseResult, 'latencyMs'> = {
    id: c.id,
    question: c.question,
    expectedClass: c.expectedClass,
    predictedClass,
    classCorrect,
    retrievedCitations: agentResult.citations,
    truePositives: overlap.truePositives,
    falsePositives: overlap.falsePositives,
    falseNegatives: overlap.falseNegatives,
    precision: overlap.precision,
    recall: overlap.recall,
    faithfulness: faith,
    status: agentResult.status,
    ...(agentResult.answer ? { answer: agentResult.answer } : {}),
    ...(agentResult.refuseReason ? { refuseReason: agentResult.refuseReason } : {}),
    ...(agentResult.errorMessage ? { errorMessage: agentResult.errorMessage } : {}),
  };
  return judgeFluency === undefined ? base : { ...base, judgeFluency };
}

function aggregate(runId: string, startedAt: string, rows: readonly PerCaseResult[]): EvalRun {
  const passed = rows.filter((r) => r.classCorrect && r.recall > 0 && r.status === 'ok').length;
  const classifierAcc = rows.length === 0 ? 0 : rows.filter((r) => r.classCorrect).length / rows.length;
  const judgeScores = rows.map((r) => r.judgeFluency).filter((v): v is number => typeof v === 'number');
  const run: EvalRun = {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    cases: rows.length,
    passed,
    classifierAcc: round(classifierAcc),
    citationPrecision: round(average(rows.map((r) => r.precision))),
    citationRecall: round(average(rows.map((r) => r.recall))),
    faithfulness: round(average(rows.map((r) => r.faithfulness))),
    ...(judgeScores.length > 0 ? { answerRelevance: round(average(judgeScores)) } : {}),
  };
  return run;
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

// Re-export the shared classifier type so consumers don't need to import it.
export type { RouterClass };
