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

export { compareToBaseline, formatComparison, loadBaseline, saveBaseline } from './baseline.js';
export type { BaselineThresholds, BaselineComparison, MetricDelta } from './baseline.js';

export { FixtureGraph } from './fixtures.js';
export type { FixtureNode, FixtureEdge, GraphFixture } from './fixtures.js';
export { FixtureAgent } from './fixture.agent.js';

export { evaluateGate, formatGate, DEFAULT_FLOORS } from './gate.js';
export type { GateFloors, GateResult, EvaluateGateOptions } from './gate.js';

export { loadLabels, renderCalibrationReport } from './calibration.report.js';
