export {
  synthesizeFlow,
  buildFlowGraph,
  clampHops,
  Neo4jFlowExecutor,
  FLOW_DEFAULT_HOPS,
  FLOW_MAX_HOPS,
  FLOW_PATH_HARD_CAP,
} from './flow.synthesis.js';
export type {
  FlowSeed,
  FlowSeedKind,
  FlowNode,
  FlowEdge,
  FlowPath,
  FlowGraph,
  FlowOptions,
  FlowExecutor,
} from './flow.synthesis.js';

export { renderSequenceDiagram, MAX_ACTORS, MAX_MESSAGES } from './mermaid.renderer.js';
export type { RenderOptions } from './mermaid.renderer.js';

export {
  analyzeImpact,
  Neo4jImpactExecutor,
  clampDepth,
  clampPerLayer,
  IMPACT_MAX_DEPTH,
  IMPACT_PER_LAYER_CAP,
} from './change.impact.js';
export type {
  ImpactLabel,
  ImpactTarget,
  ImpactOptions,
  NodeRef,
  ImpactReport,
  ImpactExecutor,
  RawImpactRow,
} from './change.impact.js';

export {
  prune,
  DEFAULT_PRUNING_POLICY,
  DEFAULT_MAX_NODES_PER_LAYER,
} from './traversal.pruning.js';
export type { PruningPolicy, Prunable, PruneOptions } from './traversal.pruning.js';

export {
  buildSnapshot,
  snapshotByteSize,
  Neo4jSnapshotSource,
  SNAPSHOT_WARN_BYTES,
} from './snapshot.builder.js';
export type {
  SnapshotPayload,
  SnapshotService,
  SnapshotEdge,
  SnapshotSummary,
  SnapshotSource,
  RawCrossEdge,
} from './snapshot.builder.js';

export { diff } from './snapshot.diff.js';
export type { SnapshotDiff, ChangedEdge, DiffSummary } from './snapshot.diff.js';

export {
  FlowNarrator,
  NARRATION_MAX_INPUT_TOKENS,
  NARRATION_MAX_OUTPUT_TOKENS,
  NARRATION_DEFAULT_BULLETS,
  renderSkeleton,
} from './flow.narrator.js';
export type {
  Narration,
  NarrationCitation,
  NarrationAudience,
  NarrateOptions,
  NarrationAgent,
  NarrationAgentResult,
} from './flow.narrator.js';

export {
  SnapshotScheduler,
  readCadenceFromEnv,
  cadenceMs,
  DEFAULT_CADENCE,
  SCHEDULER_LABEL_PREFIX,
} from './snapshot.scheduler.js';
export type {
  SnapshotCadence,
  SchedulerDeps,
  SchedulerSnapshotRepo,
} from './snapshot.scheduler.js';

export { RuntimeProviderRegistry } from './runtime.registry.js';
export { NoopRuntimeProvider } from './noop.runtime.provider.js';
export type {
  RuntimeCapability,
  RuntimeHealth,
  RuntimeEdgeEvidence,
  RuntimeSignalProvider,
} from './runtime.signal.interface.js';
