/**
 * Agent — tool-using Q&A loop.
 *
 * Hard constraints:
 *  - At most AGENT_DEFAULT_TOOL_ITERATIONS (=5) tool turns.
 *  - Total tokens (input+output) capped via budget gate.
 *  - Per-query USD budget enforced before every iteration.
 *  - Final answer must conform to the answer-contract Zod schema AND only
 *    cite IDs/paths actually returned by tools earlier in the loop.
 *  - One re-prompt on validation failure; otherwise refuse.
 *  - If the initial Phase 2.3 plan returns no retrieval signal, refuse
 *    immediately — never let the LLM hallucinate a fallback.
 *  - Multi-turn (opt-in via sessionId) loads prior messages + seenIds.
 *  - Tool results are wrapped in <untrusted> delimiters; high-risk tool
 *    outputs are also stripped of ANSI / control-token markers.
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
import {
  startTrace,
  attachClassification,
  attachPlannerDecision,
  attachToolCall as traceAttachToolCall,
  attachAnswer,
  attachRefusal,
  attachUsage,
  endTrace,
  readBudgetEnv,
  type BudgetLimits,
  type QueryTrace,
} from '@ekg/observability';
import type { LlmProvider, Message, ToolCall } from './provider.interface.js';
import type { ToolRegistry } from './tools/registry.js';
import { SeenIdSet } from './tools/tool.interface.js';
import { buildSystemPrompt } from './prompts/loader.js';
import { UNTRUSTED_GUARDRAIL } from './sanitiser.js';
import {
  validateAnswer,
  extractJson,
  type Answer,
} from './answer.contract.js';
import { AGENT_DEFAULT_TOOL_ITERATIONS } from './factory.js';
import {
  runToolCallsParallel,
  checkBudget,
  costForUsage,
  seedSeenFromPlan,
  summarisePlan,
} from './loop.helpers.js';
import {
  loadSession,
  saveSession,
  readMaxTurns,
  type SessionRepoLike,
  type SessionState,
} from './session.js';
import type { ToolCallTrace, AnswerEnvelope, AskOptions } from './agent.types.js';

export type { ToolCallTrace, AnswerEnvelope, AskOptions, AgentEvent } from './agent.types.js';

export interface AgentDeps {
  readonly provider: LlmProvider;
  readonly tools: ToolRegistry;
  readonly planExecutor: PlanExecutorDeps;
  /** Optional session repository for multi-turn. */
  readonly sessions?: SessionRepoLike;
  /** Override budget limits (defaults read from env). */
  readonly budgetLimits?: BudgetLimits;
}

interface LoopState {
  readonly system: string;
  readonly versions: { readonly base: string; readonly perClass: string };
  readonly messages: Message[];
  readonly seen: SeenIdSet;
  readonly trace: ToolCallTrace[];
  inputTokens: number;
  outputTokens: number;
  iter: number;
  toolCallsTotal: number;
}

export class Agent {
  private readonly deps: AgentDeps;
  private readonly logger: Logger;
  private readonly budget: BudgetLimits;
  private readonly maxTurnsPerSession: number;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.logger = createLogger({ service: 'agent' });
    this.budget = deps.budgetLimits ?? readBudgetEnv();
    this.maxTurnsPerSession = readMaxTurns();
  }

  async ask(question: string, opts: AskOptions = {}): Promise<AnswerEnvelope> {
    const trimmed = question.trim();
    const maxIters = Math.max(1, Math.min(opts.maxIterations ?? AGENT_DEFAULT_TOOL_ITERATIONS, AGENT_DEFAULT_TOOL_ITERATIONS));
    // Per-query token cap: explicit opts override the constructor budget;
    // otherwise stay with the constructor budget so USD/tool-call caps still fire.
    const limits: BudgetLimits = opts.maxTokens !== undefined
      ? { ...this.budget, maxTokens: Math.max(1, opts.maxTokens) }
      : this.budget;

    const queryTrace = startTrace(trimmed);
    const cls = classify(trimmed);
    attachClassification(queryTrace, { class: cls.class, confidence: cls.confidence });

    const session = this.loadSessionOrRefuse(opts.sessionId, queryTrace, trimmed, cls);
    if (session && 'refusal' in session) return session.refusal;

    const strategy = selectStrategy(cls.class);
    const plan = await this.runPlan(trimmed, cls.class, strategy, opts);
    attachPlannerDecision(queryTrace, {
      strategy: plan.strategy.kind,
      sources: plan.sources,
      notes: plan.notes,
      durationMs: plan.duration_ms,
    });

    const state = this.initLoopState(cls.class, trimmed, plan, opts, session?.state);
    return this.runLoop(state, limits, maxIters, queryTrace, trimmed, cls, opts.sessionId);
  }

  private async runLoop(
    state: LoopState,
    limits: BudgetLimits,
    maxIters: number,
    queryTrace: QueryTrace,
    question: string,
    cls: { class: QuestionClass; confidence: number },
    sessionId: string | undefined,
  ): Promise<AnswerEnvelope> {
    let validationError: string | undefined;
    while (state.iter < maxIters) {
      const budget = checkBudget(this.snapshot(state), limits);
      if (!budget.ok) {
        return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined,
          `BUDGET_EXCEEDED: ${budget.reason}`, state, sessionId);
      }
      state.iter += 1;
      const completion = await this.deps.provider.complete({
        system: state.system,
        messages: state.messages,
        tools: this.deps.tools.specs(),
        maxTokens: 1024,
        temperature: 0.2,
      });
      state.inputTokens += completion.usage.inputTokens;
      state.outputTokens += completion.usage.outputTokens;

      if (completion.stopReason === 'tool_use' && completion.toolCalls.length > 0) {
        if (completion.content) state.messages.push({ role: 'assistant', content: completion.content });
        await this.dispatchTools(completion.toolCalls, state, queryTrace);
        continue;
      }

      const result = this.tryValidate(completion.content, state.seen);
      if (result.ok) {
        if (sessionId) this.persistSession(sessionId, state, cls.class);
        return this.finishEnvelope(queryTrace, 'ok', question, cls, result.answer, undefined, state, sessionId);
      }
      validationError = result.error;
      if (result.error.startsWith('REFUSE:')) {
        return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined, result.error, state, sessionId);
      }
      state.messages.push({ role: 'assistant', content: completion.content || '<empty>' });
      state.messages.push({
        role: 'user',
        content: `Your previous answer failed validation: ${result.error}. Reply with ONLY a single JSON object matching the schema. Do not invent citations. If you cannot ground every claim in a tool result, refuse.`,
      });
      break;
    }

    if (validationError === undefined) {
      return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined,
        'tool-loop exhausted before final answer', state, sessionId);
    }
    return this.reprompt(state, limits, queryTrace, question, cls, sessionId);
  }

  private async reprompt(
    state: LoopState,
    limits: BudgetLimits,
    queryTrace: QueryTrace,
    question: string,
    cls: { class: QuestionClass; confidence: number },
    sessionId: string | undefined,
  ): Promise<AnswerEnvelope> {
    const budget = checkBudget(this.snapshot(state), limits);
    if (!budget.ok) {
      return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined,
        `BUDGET_EXCEEDED: ${budget.reason}`, state, sessionId);
    }
    state.iter += 1;
    const retry = await this.deps.provider.complete({
      system: state.system, messages: state.messages,
      tools: this.deps.tools.specs(), maxTokens: 1024, temperature: 0,
    });
    state.inputTokens += retry.usage.inputTokens;
    state.outputTokens += retry.usage.outputTokens;
    const final = this.tryValidate(retry.content, state.seen);
    if (final.ok) {
      if (sessionId) this.persistSession(sessionId, state, cls.class);
      return this.finishEnvelope(queryTrace, 'ok', question, cls, final.answer, undefined, state, sessionId);
    }
    this.logger.info({ class: cls.class, error: final.error }, 'agent refused after re-prompt');
    return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined, final.error, state, sessionId);
  }

  private async dispatchTools(calls: readonly ToolCall[], state: LoopState, queryTrace: QueryTrace): Promise<void> {
    const outcomes = await runToolCallsParallel(this.deps.tools, calls, state.iter, state.seen);
    state.toolCallsTotal += outcomes.length;
    for (const o of outcomes) {
      state.trace.push(o.trace);
      state.messages.push(o.message);
      traceAttachToolCall(queryTrace, {
        turn: o.trace.turn, toolName: o.trace.toolName, ok: o.trace.ok,
        latencyMs: o.trace.latencyMs, summary: o.trace.resultSummary,
      });
    }
  }

  private snapshot(state: LoopState) {
    return {
      tokensIn: state.inputTokens,
      tokensOut: state.outputTokens,
      toolCalls: state.toolCallsTotal,
      costUsd: costForUsage(this.deps.provider.id, this.deps.provider.model, state.inputTokens, state.outputTokens),
    };
  }

  private tryValidate(content: string, seen: SeenIdSet) {
    const parsed = extractJson(content);
    return validateAnswer(parsed, { seen, retrievalEmpty: seen.values().length === 0 });
  }

  private loadSessionOrRefuse(
    sessionId: string | undefined,
    queryTrace: QueryTrace,
    question: string,
    cls: { class: QuestionClass; confidence: number },
  ): { state: SessionState | undefined } | { refusal: AnswerEnvelope } | undefined {
    if (!sessionId) return undefined;
    if (!this.deps.sessions) {
      return { refusal: this.makeRefusal(queryTrace, question, cls, 'session repository not configured', sessionId) };
    }
    const state = loadSession(this.deps.sessions, sessionId);
    if (!state) {
      return { refusal: this.makeRefusal(queryTrace, question, cls, `unknown sessionId: ${sessionId}`, sessionId) };
    }
    const turnCount = state.metadata.turnCount ?? 0;
    if (turnCount >= this.maxTurnsPerSession) {
      return { refusal: this.makeRefusal(queryTrace, question, cls,
        `session exhausted: ${turnCount}/${this.maxTurnsPerSession} turns; start a new session`, sessionId) };
    }
    return { state };
  }

  private makeRefusal(
    queryTrace: QueryTrace, question: string,
    cls: { class: QuestionClass; confidence: number },
    reason: string, sessionId: string,
  ): AnswerEnvelope {
    const empty: LoopState = {
      system: '', versions: { base: 'n/a', perClass: 'n/a' },
      messages: [], seen: new SeenIdSet(), trace: [],
      inputTokens: 0, outputTokens: 0, iter: 0, toolCallsTotal: 0,
    };
    return this.finishEnvelope(queryTrace, 'refused', question, cls, undefined, reason, empty, sessionId);
  }

  private initLoopState(
    cls: QuestionClass, question: string, plan: PlanResult, opts: AskOptions,
    prior: SessionState | undefined,
  ): LoopState {
    const seen = new SeenIdSet();
    seedSeenFromPlan(seen, plan);
    if (prior) for (const id of prior.seenIds) seen.add(id);

    const { system: baseSys, versions } = buildSystemPrompt(cls);
    const system = `${baseSys}\n\n${UNTRUSTED_GUARDRAIL}`;
    const planSummary = summarisePlan(plan);
    const userTurn: Message = {
      role: 'user',
      content: [
        `Question: ${question}`,
        '',
        '## Initial deterministic retrieval (Phase 2.3 planner)',
        planSummary,
        '',
        opts.repo ? `Restrict tools to repo: ${opts.repo}` : 'No repo restriction.',
      ].join('\n'),
    };
    const messages: Message[] = prior ? [...prior.messages, userTurn] : [userTurn];
    return {
      system, versions, messages, seen, trace: [],
      inputTokens: 0, outputTokens: 0, iter: 0, toolCallsTotal: 0,
    };
  }

  private persistSession(sessionId: string, state: LoopState, cls: QuestionClass): void {
    if (!this.deps.sessions) return;
    const prior = loadSession(this.deps.sessions, sessionId);
    const turnCount = (prior?.metadata.turnCount ?? 0) + 1;
    saveSession(this.deps.sessions, sessionId, {
      messages: state.messages,
      seenIds: state.seen.values(),
      metadata: { classification: cls, turnCount, tokensUsedTotal: (prior?.metadata.tokensUsedTotal ?? 0) + state.inputTokens + state.outputTokens },
    });
  }

  private async runPlan(
    question: string, cls: QuestionClass,
    strategy: ReturnType<typeof selectStrategy>, opts: AskOptions,
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
        question, class: cls, strategy,
        entities: { serviceNames: [] }, results: {}, sources: [],
        duration_ms: 0, notes: [`plan-failed: ${msg}`],
      };
    }
  }

  private finishEnvelope(
    queryTrace: QueryTrace,
    status: AnswerEnvelope['status'],
    question: string,
    cls: { class: QuestionClass; confidence: number },
    answer: Answer | undefined,
    refusedReason: string | undefined,
    state: LoopState,
    sessionId: string | undefined,
  ): AnswerEnvelope {
    if (answer) attachAnswer(queryTrace, { confidence: answer.confidence, citations: answer.citations.length });
    if (refusedReason) attachRefusal(queryTrace, refusedReason);
    attachUsage(queryTrace, state.inputTokens, state.outputTokens);
    endTrace(queryTrace);
    const costUsd = costForUsage(this.deps.provider.id, this.deps.provider.model, state.inputTokens, state.outputTokens);
    return {
      status, question,
      classification: { class: cls.class, confidence: cls.confidence },
      ...(answer ? { answer } : {}),
      ...(refusedReason ? { refused: { reason: refusedReason } } : {}),
      trace: state.trace,
      usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens, iterations: state.iter, costUsd },
      promptVersions: state.versions,
      traceId: queryTrace.traceId,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}
