export type {
  EvalCase,
  EvalRun,
  PerCaseResult,
  QuestionClass,
} from './eval.types.js';

export { citationOverlap, faithfulness, average } from './metrics.js';
export type { CitationOverlap } from './metrics.js';

export { runEval } from './eval.runner.js';
export type { EvalAgent, EvalAgentResult, RunEvalOptions } from './eval.runner.js';

export { loadCasesFromFile, parseCases, evalCasesSchema } from './cases.loader.js';

export { makeFluencyJudge, readJudgeEnv } from './llm.judge.js';
export type { JudgeOptions } from './llm.judge.js';

export { enforce, readThresholdsFromEnv, DEFAULT_THRESHOLDS } from './thresholds.js';
export type { EvalThresholds, EnforcementResult } from './thresholds.js';

export { Bm25Agent, tryBuildBm25Agent } from './bm25.agent.js';
export type { Bm25AgentOptions } from './bm25.agent.js';
