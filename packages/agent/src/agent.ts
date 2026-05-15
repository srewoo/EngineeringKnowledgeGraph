/**
 * Agent — tool-using Q&A loop.
 *
 * Hard constraints:
 *  - At most AGENT_DEFAULT_TOOL_ITERATIONS (=5) tool turns.
 *  - Total tokens (input+output) capped at `maxTokens` (default 8000).
 *  - Final answer must conform to the answer-contract Zod schema AND only
 *    cite IDs/paths actually returned by tools earlier in the loop.
 *  - One re-prompt on validation failure; otherwise refuse.
 *  - If the initial Phase 2.3 plan returns no retrieval signal, refuse
 *    immediately — never let the LLM hallucinate a fallback.
 */

import { createLogger, type Logger } from '@ekg/shared';
import {
  classify,
  selectStrategy,
  executePlan,
  type PlanResult,
  type PlanExecutorDeps,
  type QuestionClass,
} from '@ekg/router';
import type { LlmProvider, Message, ToolCall } from './provider.interface.js';
import type { ToolRegistry } from './tools/registry.js';
import { SeenIdSet } from './tools/tool.interface.js';
import { buildSystemPrompt } from './prompts/loader.js';
import {
  validateAnswer,
  extractJson,
  type Answer,
} from './answer.contract.js';
import { AGENT_DEFAULT_MAX_TOKENS, AGENT_DEFAULT_TOOL_ITERATIONS } from './factory.js';

export interface AskOptions {
  readonly repo?: string;
  readonly k?: number;
  readonly maxTokens?: number;
  readonly maxIterations?: number;
}

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
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly iterations: number };
  readonly promptVersions: { readonly base: string; readonly perClass: string };
}

export interface AgentDeps {
  readonly provider: LlmProvider;
  readonly tools: ToolRegistry;
  readonly planExecutor: PlanExecutorDeps;
}

const SUMMARY_CAP = 500;

export class Agent {
  private readonly deps: AgentDeps;
  private readonly logger: Logger;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.logger = createLogger({ service: 'agent' });
  }

  async ask(question: string, opts: AskOptions = {}): Promise<AnswerEnvelope> {
    const trimmed = question.trim();
    const maxIters = Math.max(1, Math.min(opts.maxIterations ?? AGENT_DEFAULT_TOOL_ITERATIONS, AGENT_DEFAULT_TOOL_ITERATIONS));
    const maxTokens = Math.max(512, opts.maxTokens ?? AGENT_DEFAULT_MAX_TOKENS);

    const cls = classify(trimmed);
    const strategy = selectStrategy(cls.class);
    const plan = await this.runPlan(trimmed, cls.class, strategy, opts);
    const seen = new SeenIdSet();
    seedSeenFromPlan(seen, plan);

    const { system, versions } = buildSystemPrompt(cls.class);
    const planSummary = summarisePlan(plan);

    const messages: Message[] = [{
      role: 'user',
      content: [
        `Question: ${trimmed}`,
        '',
        '## Initial deterministic retrieval (Phase 2.3 planner)',
        planSummary,
        '',
        opts.repo ? `Restrict tools to repo: ${opts.repo}` : 'No repo restriction.',
      ].join('\n'),
    }];

    const trace: ToolCallTrace[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let iter = 0;
    let lastAssistantText = '';
    let validationError: string | undefined;

    while (iter < maxIters) {
      if (inputTokens + outputTokens >= maxTokens) {
        this.logger.warn({ inputTokens, outputTokens, maxTokens }, 'token budget exhausted');
        break;
      }
      iter += 1;
      const completion = await this.deps.provider.complete({
        system,
        messages,
        tools: this.deps.tools.specs(),
        maxTokens: 1024,
        temperature: 0.2,
      });
      inputTokens += completion.usage.inputTokens;
      outputTokens += completion.usage.outputTokens;
      lastAssistantText = completion.content;

      if (completion.stopReason === 'tool_use' && completion.toolCalls.length > 0) {
        if (completion.content) {
          messages.push({ role: 'assistant', content: completion.content });
        }
        for (const tc of completion.toolCalls) {
          const toolMsg = await this.runToolCall(tc, iter, seen, trace);
          messages.push(toolMsg);
        }
        continue;
      }

      // Terminal turn — try to validate
      const parsed = extractJson(completion.content);
      const result = validateAnswer(parsed, {
        seen,
        retrievalEmpty: seen.values().length === 0,
      });
      if (result.ok) {
        return this.envelope('ok', trimmed, cls, result.answer, undefined, trace, inputTokens, outputTokens, iter, versions);
      }
      validationError = result.error;
      if (result.error.startsWith('REFUSE:')) {
        return this.envelope('refused', trimmed, cls, undefined, result.error, trace, inputTokens, outputTokens, iter, versions);
      }
      // One re-prompt with explicit error description, then bail.
      messages.push({ role: 'assistant', content: completion.content || '<empty>' });
      messages.push({
        role: 'user',
        content: `Your previous answer failed validation: ${result.error}. Reply with ONLY a single JSON object matching the schema. Do not invent citations. If you cannot ground every claim in a tool result, refuse.`,
      });
      break;
    }

    if (validationError === undefined) {
      return this.envelope('refused', trimmed, cls, undefined, 'tool-loop exhausted before final answer', trace, inputTokens, outputTokens, iter, versions);
    }

    // Re-prompt round
    iter += 1;
    const retry = await this.deps.provider.complete({
      system,
      messages,
      tools: this.deps.tools.specs(),
      maxTokens: 1024,
      temperature: 0,
    });
    inputTokens += retry.usage.inputTokens;
    outputTokens += retry.usage.outputTokens;
    const reparsed = extractJson(retry.content);
    const final = validateAnswer(reparsed, { seen, retrievalEmpty: seen.values().length === 0 });
    if (final.ok) {
      return this.envelope('ok', trimmed, cls, final.answer, undefined, trace, inputTokens, outputTokens, iter, versions);
    }
    this.logger.info({ class: cls.class, error: final.error, lastAssistantText }, 'agent refused after re-prompt');
    return this.envelope('refused', trimmed, cls, undefined, final.error, trace, inputTokens, outputTokens, iter, versions);
  }

  private async runPlan(
    question: string,
    cls: QuestionClass,
    strategy: ReturnType<typeof selectStrategy>,
    opts: AskOptions,
  ): Promise<PlanResult> {
    try {
      return await executePlan(question, cls, strategy, this.deps.planExecutor, {
        ...(opts.k ? { k: opts.k } : {}),
        ...(opts.repo ? { repoUrl: opts.repo } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg }, 'initial plan execution failed');
      return {
        question,
        class: cls,
        strategy,
        entities: { serviceNames: [] },
        results: {},
        sources: [],
        duration_ms: 0,
        notes: [`plan-failed: ${msg}`],
      };
    }
  }

  private async runToolCall(
    tc: ToolCall,
    turn: number,
    seen: SeenIdSet,
    trace: ToolCallTrace[],
  ): Promise<Message> {
    const t0 = Date.now();
    const r = await this.deps.tools.invoke(tc.name, tc.arguments);
    const latencyMs = Date.now() - t0;
    if (!r.ok || !r.result) {
      trace.push({
        turn, toolName: tc.name, args: tc.arguments,
        resultSummary: truncate(r.error ?? 'unknown error', SUMMARY_CAP),
        latencyMs, ok: false,
      });
      return {
        role: 'tool', toolCallId: tc.id, toolName: tc.name,
        content: `error: ${r.error ?? 'unknown error'}`, isError: true,
      };
    }
    for (const id of r.result.seenIds) seen.add(id);
    trace.push({
      turn, toolName: tc.name, args: tc.arguments,
      resultSummary: truncate(r.result.text, SUMMARY_CAP),
      latencyMs, ok: true,
    });
    return {
      role: 'tool', toolCallId: tc.id, toolName: tc.name, content: r.result.text,
    };
  }

  private envelope(
    status: AnswerEnvelope['status'],
    question: string,
    cls: { class: QuestionClass; confidence: number },
    answer: Answer | undefined,
    refusedReason: string | undefined,
    trace: readonly ToolCallTrace[],
    inputTokens: number,
    outputTokens: number,
    iterations: number,
    promptVersions: { base: string; perClass: string },
  ): AnswerEnvelope {
    return {
      status,
      question,
      classification: { class: cls.class, confidence: cls.confidence },
      ...(answer ? { answer } : {}),
      ...(refusedReason ? { refused: { reason: refusedReason } } : {}),
      trace,
      usage: { inputTokens, outputTokens, iterations },
      promptVersions,
    };
  }
}

function seedSeenFromPlan(seen: SeenIdSet, plan: PlanResult): void {
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

function summarisePlan(plan: PlanResult): string {
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

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}
