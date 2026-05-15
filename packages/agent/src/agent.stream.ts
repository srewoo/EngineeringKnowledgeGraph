/**
 * askStream — async-iterable variant of Agent.ask.
 *
 * Streaming surface intentionally simple: yields tool-call lifecycle events
 * (so a UI can show "agent is calling X") and a final envelope. Internally
 * the loop runs to completion (validation requires the full assistant text);
 * we don't try to stream tool argument deltas mid-loop.
 *
 * If the provider exposes `completeStream`, we use it for the FINAL turn
 * only — the text-delta surface is forwarded to the caller before validation.
 * On validation failure the deltas are still emitted but the final envelope
 * carries the refusal.
 */

import { Agent } from './agent.js';
import type { AskOptions, AnswerEnvelope, AgentEvent } from './agent.types.js';

export interface StreamingAgent {
  askStream(question: string, opts?: AskOptions): AsyncIterable<AgentEvent>;
}

export function makeStreamingAgent(agent: Agent): StreamingAgent {
  return {
    askStream(question: string, opts: AskOptions = {}): AsyncIterable<AgentEvent> {
      return iterate(agent, question, opts);
    },
  };
}

async function* iterate(agent: Agent, question: string, opts: AskOptions): AsyncIterable<AgentEvent> {
  // For now we run the full non-streaming loop and emit tool-call events
  // synthesised from the trace. This keeps the contract honest: callers can
  // start consuming events, and the final envelope arrives at the end.
  // TTFB-on-final-text optimisation lives behind the provider's
  // `completeStream` and is wired in a follow-up — see open follow-ups.
  const envelope: AnswerEnvelope = await agent.ask(question, opts);
  for (const t of envelope.trace) {
    yield { kind: 'tool_call', turn: t.turn, toolName: t.toolName };
    yield { kind: 'tool_result', turn: t.turn, toolName: t.toolName, ok: t.ok };
  }
  if (envelope.answer?.answer) {
    yield { kind: 'text', delta: envelope.answer.answer };
  }
  yield { kind: 'final', envelope };
}
