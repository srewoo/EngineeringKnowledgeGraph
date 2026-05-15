/**
 * QueryTrace — structured per-question agent trace.
 *
 * Builder-style mutable container. Persisted via Pino on `endTrace`.
 * Mirrors AnswerEnvelope but is observability-specific (not a contract).
 */

import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '@ekg/shared';

export interface TraceClassification {
  readonly class: string;
  readonly confidence: number;
}

export interface TracePlannerDecision {
  readonly strategy: string;
  readonly sources: readonly string[];
  readonly notes: readonly string[];
  readonly durationMs: number;
}

export interface TraceRetrievalCall {
  readonly kind: string;
  readonly resultCount: number;
  readonly latencyMs: number;
}

export interface TraceToolCall {
  readonly turn: number;
  readonly toolName: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly summary: string;
}

export interface TraceAnswer {
  readonly confidence: string;
  readonly citations: number;
}

export interface QueryTrace {
  readonly traceId: string;
  readonly startedAt: string;
  question: string;
  classification?: TraceClassification;
  plannerDecision?: TracePlannerDecision;
  retrievalCalls: TraceRetrievalCall[];
  toolCalls: TraceToolCall[];
  finalAnswer?: TraceAnswer;
  refused?: boolean;
  refuseReason?: string;
  errored?: boolean;
  errorMessage?: string;
  latencyMs?: number;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}

const traceLogger: Logger = createLogger({ service: 'agent-trace' });
const startTimes = new WeakMap<QueryTrace, number>();

export function startTrace(question: string): QueryTrace {
  const trace: QueryTrace = {
    traceId: randomUUID(),
    startedAt: new Date().toISOString(),
    question,
    retrievalCalls: [],
    toolCalls: [],
    tokensIn: 0,
    tokensOut: 0,
  };
  startTimes.set(trace, Date.now());
  return trace;
}

export function attachClassification(t: QueryTrace, c: TraceClassification): void {
  t.classification = c;
}

export function attachPlannerDecision(t: QueryTrace, p: TracePlannerDecision): void {
  t.plannerDecision = p;
}

export function attachRetrieval(t: QueryTrace, call: TraceRetrievalCall): void {
  t.retrievalCalls.push(call);
}

export function attachToolCall(t: QueryTrace, call: TraceToolCall): void {
  t.toolCalls.push(call);
}

export function attachAnswer(t: QueryTrace, ans: TraceAnswer): void {
  t.finalAnswer = ans;
}

export function attachRefusal(t: QueryTrace, reason: string): void {
  t.refused = true;
  t.refuseReason = reason;
}

export function attachError(t: QueryTrace, message: string): void {
  t.errored = true;
  t.errorMessage = message;
}

export function attachUsage(t: QueryTrace, tokensIn: number, tokensOut: number, costUsd?: number): void {
  t.tokensIn = tokensIn;
  t.tokensOut = tokensOut;
  if (typeof costUsd === 'number') t.costUsd = costUsd;
}

export function endTrace(t: QueryTrace): QueryTrace {
  const start = startTimes.get(t) ?? Date.parse(t.startedAt);
  t.latencyMs = Date.now() - start;
  traceLogger.info({ trace: t }, 'agent.query.completed');
  return t;
}
