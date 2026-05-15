/**
 * Eval-set types — shared between cases JSON, runner, and CLI.
 *
 * QuestionClass mirrors `@ekg/router` taxonomy. Kept as a local string
 * union so the eval set is self-describing without coupling JSON files
 * to runtime imports.
 */

export type QuestionClass =
  | 'topology' | 'schema' | 'code' | 'flow' | 'ownership'
  | 'api' | 'config' | 'ops' | 'history' | 'unknown';

export interface EvalCase {
  readonly id: string;
  readonly question: string;
  readonly expectedClass: QuestionClass;
  /** Refs the answer should cite (e.g. "Table:User", "repo:path:start-end"). */
  readonly goldCitations: readonly string[];
  /** Optional human-written reference answer. Not used for faithfulness. */
  readonly goldAnswer?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface PerCaseResult {
  readonly id: string;
  readonly question: string;
  readonly expectedClass: QuestionClass;
  readonly predictedClass: QuestionClass;
  readonly classCorrect: boolean;
  readonly retrievedCitations: readonly string[];
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly faithfulness: number;
  readonly judgeFluency?: number;
  readonly status: 'ok' | 'refused' | 'error';
  readonly answer?: string;
  readonly refuseReason?: string;
  readonly errorMessage?: string;
  readonly latencyMs: number;
}

export interface EvalRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly cases: number;
  readonly passed: number;
  readonly classifierAcc: number;     // 0..1
  readonly citationPrecision: number; // 0..1
  readonly citationRecall: number;    // 0..1
  readonly faithfulness: number;      // citation-overlap based, 0..1
  readonly answerRelevance?: number;  // optional LLM-as-judge
}
