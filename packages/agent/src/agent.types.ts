/**
 * Shared types for the Agent and its helpers. Kept tiny so both files can
 * import without circular deps.
 */

import type { QuestionClass } from '@ekg/router';
import type { Answer } from './answer.contract.js';

export interface ToolCallTrace {
  readonly turn: number;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly resultSummary: string;
  readonly latencyMs: number;
  readonly ok: boolean;
}

export interface AnswerEnvelope {
  readonly status: 'ok' | 'refused' | 'error';
  readonly question: string;
  readonly classification: { readonly class: QuestionClass; readonly confidence: number };
  readonly answer?: Answer;
  readonly refused?: { readonly reason: string };
  readonly trace: readonly ToolCallTrace[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly iterations: number; readonly costUsd?: number };
  readonly promptVersions: { readonly base: string; readonly perClass: string };
  readonly traceId: string;
  readonly sessionId?: string;
}

export interface AskOptions {
  readonly repo?: string;
  readonly k?: number;
  readonly maxTokens?: number;
  readonly maxIterations?: number;
  readonly sessionId?: string;
}

export type AgentEvent =
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'tool_call'; readonly turn: number; readonly toolName: string }
  | { readonly kind: 'tool_result'; readonly turn: number; readonly toolName: string; readonly ok: boolean }
  | { readonly kind: 'final'; readonly envelope: AnswerEnvelope };
