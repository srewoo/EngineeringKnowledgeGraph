export {
  startTrace,
  attachClassification,
  attachPlannerDecision,
  attachRetrieval,
  attachToolCall,
  attachAnswer,
  attachRefusal,
  attachError,
  attachUsage,
  endTrace,
} from './trace.js';
export type {
  QueryTrace,
  TraceClassification,
  TracePlannerDecision,
  TraceRetrievalCall,
  TraceToolCall,
  TraceAnswer,
} from './trace.js';

export { estimateCost, MODEL_COST_PER_1K_TOKENS } from './cost.meter.js';
export type { ProviderId, CostEstimate } from './cost.meter.js';

export { FeedbackRepository } from './feedback.repository.js';
export type { FeedbackRow, FeedbackVerdict } from './feedback.repository.js';

export { enforceBudget, readBudgetEnv, DEFAULT_BUDGET_LIMITS } from './budget.js';
export type { BudgetLimits, BudgetState, BudgetCheck } from './budget.js';
