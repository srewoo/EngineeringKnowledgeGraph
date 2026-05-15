/**
 * Pure helpers used by the Agent main loop.
 *  - Parallel tool dispatch (capped fan-out).
 *  - Budget enforcement bridging.
 *  - Plan summary / seen-set seeding.
 */

import type { ToolRegistry } from './tools/registry.js';
import type { SeenIdSet } from './tools/tool.interface.js';
import type { Message, ToolCall } from './provider.interface.js';
import type { ToolCallTrace } from './agent.types.js';
import { sanitiseForLlm } from './sanitiser.js';
import {
  enforceBudget,
  estimateCost,
  type BudgetLimits,
  type ProviderId,
} from '@ekg/observability';
import type { PlanResult } from '@ekg/router';

export const PARALLEL_TOOL_CAP = 6;
const SUMMARY_CAP = 500;

export interface ToolCallOutcome {
  readonly message: Message;
  readonly trace: ToolCallTrace;
}

/**
 * Run all tool calls from one assistant turn in parallel (capped). Each
 * outcome contains the user-role message to feed back to the model AND
 * a trace entry. Errors are captured per tool — never throw out of the loop.
 */
export async function runToolCallsParallel(
  registry: ToolRegistry,
  calls: readonly ToolCall[],
  turn: number,
  seen: SeenIdSet,
): Promise<ToolCallOutcome[]> {
  const limited = calls.slice(0, PARALLEL_TOOL_CAP);
  return Promise.all(limited.map((tc) => runOne(registry, tc, turn, seen)));
}

async function runOne(
  registry: ToolRegistry,
  tc: ToolCall,
  turn: number,
  seen: SeenIdSet,
): Promise<ToolCallOutcome> {
  const t0 = Date.now();
  const r = await registry.invoke(tc.name, tc.arguments);
  const latencyMs = Date.now() - t0;
  if (!r.ok || !r.result) {
    const errText = r.error ?? 'unknown error';
    return {
      trace: {
        turn, toolName: tc.name, args: tc.arguments,
        resultSummary: truncate(errText, SUMMARY_CAP),
        latencyMs, ok: false,
      },
      message: {
        role: 'tool', toolCallId: tc.id, toolName: tc.name,
        content: sanitiseForLlm(tc.name, tc.id, `error: ${errText}`),
        isError: true,
      },
    };
  }
  for (const id of r.result.seenIds) seen.add(id);
  return {
    trace: {
      turn, toolName: tc.name, args: tc.arguments,
      resultSummary: truncate(r.result.text, SUMMARY_CAP),
      latencyMs, ok: true,
    },
    message: {
      role: 'tool', toolCallId: tc.id, toolName: tc.name,
      content: sanitiseForLlm(tc.name, tc.id, r.result.text),
    },
  };
}

export interface BudgetSnapshot {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly toolCalls: number;
  readonly costUsd: number;
}

export function checkBudget(
  snap: BudgetSnapshot,
  limits: BudgetLimits,
): { ok: true } | { ok: false; reason: string } {
  const result = enforceBudget(
    {
      tokensIn: snap.tokensIn,
      tokensOut: snap.tokensOut,
      costUsd: snap.costUsd,
      toolCalls: snap.toolCalls,
    },
    limits,
  );
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason ?? 'BUDGET_EXCEEDED' };
}

export function costForUsage(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return estimateCost(providerId, model, inputTokens, outputTokens).costUsd;
}

export function seedSeenFromPlan(seen: SeenIdSet, plan: PlanResult): void {
  const graphRows = plan.results.graph ?? plan.results.multiHop?.seeds ?? [];
  for (const row of graphRows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && (k === 'id' || k.endsWith('Id') || k.endsWith('_id') || k === 'name' || k === 'startName')) {
        seen.add(v);
      }
    }
  }
  const hybrid = plan.results.hybrid ?? plan.results.multiHop?.hybrid ?? [];
  for (const h of hybrid) {
    seen.add(h.id);
    seen.add(`${h.label}:${h.nodeId}`);
    if (h.path) seen.add(h.path);
  }
}

export function summarisePlan(plan: PlanResult): string {
  const lines: string[] = [];
  lines.push(`class=${plan.class} strategy=${plan.strategy.kind} sources=${plan.sources.join(',') || 'none'} duration_ms=${plan.duration_ms}`);
  if (plan.entities.serviceNames.length > 0) {
    lines.push(`entities.services=${plan.entities.serviceNames.join(',')}`);
  }
  if (plan.notes.length > 0) {
    lines.push(`notes=${plan.notes.join(' | ')}`);
  }
  const graphRows = plan.results.graph ?? plan.results.multiHop?.seeds ?? [];
  if (graphRows.length > 0) {
    lines.push(`graph=${graphRows.length} rows. First: ${truncate(JSON.stringify(graphRows[0]), 240)}`);
  }
  const hybrid = plan.results.hybrid ?? plan.results.multiHop?.hybrid ?? [];
  if (hybrid.length > 0) {
    const top = hybrid.slice(0, 5).map((h) => `${h.label}:${h.name} (${h.path})`).join(' | ');
    lines.push(`hybrid_top=${top}`);
  }
  if (graphRows.length === 0 && hybrid.length === 0) {
    lines.push('NO RESULTS — refuse if you cannot ground via tools.');
  }
  return lines.join('\n');
}

export function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}
