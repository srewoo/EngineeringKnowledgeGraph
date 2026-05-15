/**
 * FlowNarrator — turn a deterministic FlowGraph into prose with citations.
 *
 * Two modes:
 *
 *  1. **Deterministic (default)** — when no agent is wired, walk the flow
 *     paths and emit a plain-English template. Pure function, zero LLM cost,
 *     suitable for CI / offline / agent-disabled deploys.
 *
 *  2. **LLM-polished** — when an `Agent` is provided, hand the model a tight
 *     system prompt + the FlowGraph + the deterministic skeleton and ask for
 *     a polished narrative. Citations come from the FlowGraph node IDs so the
 *     answer-contract validator accepts them as "seen".
 *
 * The narrator is **on-demand** — never invoked during snapshot or ingest.
 */

import type { FlowGraph, FlowEdge, FlowNode } from './flow.synthesis.js';

export interface NarrationCitation {
  readonly kind: 'graph';
  readonly ref: string;
  readonly excerpt?: string;
}

export interface Narration {
  readonly text: string;
  readonly citations: readonly NarrationCitation[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly mode: 'deterministic' | 'llm';
}

export type NarrationAudience = 'engineer' | 'pm';

export interface NarrateOptions {
  readonly audience?: NarrationAudience;
  readonly maxBullets?: number;
}

/**
 * Minimal Agent interface — keeps `@ekg/advanced` from depending on
 * `@ekg/agent` (which in turn would create a cycle through `@ekg/router`).
 * The MCP tool injects an actual `Agent` instance which structurally matches.
 */
export interface NarrationAgent {
  ask(
    question: string,
    opts?: { readonly maxTokens?: number; readonly maxIterations?: number },
  ): Promise<NarrationAgentResult>;
}

export interface NarrationAgentResult {
  readonly status: 'ok' | 'refused';
  readonly answer?: { readonly answer: string };
  readonly refused?: { readonly reason: string };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export const NARRATION_MAX_INPUT_TOKENS = 3_000;
export const NARRATION_MAX_OUTPUT_TOKENS = 800;
export const NARRATION_DEFAULT_BULLETS = 6;

export class FlowNarrator {
  private readonly agent: NarrationAgent | null;

  constructor(agent: NarrationAgent | null = null) {
    this.agent = agent;
  }

  async narrate(flow: FlowGraph, opts: NarrateOptions = {}): Promise<Narration> {
    const skeleton = renderSkeleton(flow, opts);
    const citations = collectCitations(flow);
    if (!this.agent) {
      return { text: skeleton, citations, mode: 'deterministic' };
    }
    const prompt = buildPrompt(flow, skeleton, opts);
    const result = await this.agent.ask(prompt, {
      maxTokens: NARRATION_MAX_OUTPUT_TOKENS,
      maxIterations: 1,
    });
    if (result.status !== 'ok' || !result.answer) {
      // Fall back to the deterministic skeleton on refusal — never block the
      // caller on LLM availability.
      return {
        text: skeleton,
        citations,
        mode: 'deterministic',
        ...(result.usage ? { usage: result.usage } : {}),
      };
    }
    return {
      text: result.answer.answer,
      citations,
      mode: 'llm',
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}

export function renderSkeleton(flow: FlowGraph, opts: NarrateOptions = {}): string {
  const audience = opts.audience ?? 'engineer';
  const maxBullets = clampBullets(opts.maxBullets ?? NARRATION_DEFAULT_BULLETS);
  const seedDesc = `${flow.seed.kind}:${flow.seed.value}`;
  if (flow.nodes.length === 0) {
    return `No flow could be synthesized from seed ${seedDesc}.`;
  }
  const lines: string[] = [];
  lines.push(`Flow seeded at ${seedDesc} (${flow.nodes.length} nodes, ${flow.edges.length} edges).`);
  const sentences = describeEdges(flow, audience);
  for (const s of sentences.slice(0, maxBullets)) lines.push(`- ${s}`);
  if (sentences.length > maxBullets) {
    lines.push(`- ...and ${sentences.length - maxBullets} more step(s) elided.`);
  }
  if (flow.truncated) {
    lines.push('- Note: walk was truncated at the path-cap; the picture may be incomplete.');
  }
  return lines.join('\n');
}

function describeEdges(flow: FlowGraph, audience: NarrationAudience): string[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
  const out: string[] = [];
  for (const e of flow.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    out.push(describeEdge(a, b, e, audience));
  }
  return out;
}

function describeEdge(a: FlowNode, b: FlowNode, e: FlowEdge, audience: NarrationAudience): string {
  const aDesc = `${a.label} ${a.name || a.id}`;
  const bDesc = `${b.label} ${b.name || b.id}`;
  const verb = verbFor(e.type, audience);
  return `${aDesc} ${verb} ${bDesc}.`;
}

function verbFor(type: string, audience: NarrationAudience): string {
  const eng = audience === 'engineer';
  switch (type) {
    case 'CALLS': return eng ? 'calls' : 'invokes';
    case 'CALLS_API': return eng ? 'calls the API of' : 'sends a request to';
    case 'EXPOSES': return 'exposes';
    case 'PRODUCES': return eng ? 'produces messages onto' : 'publishes events to';
    case 'CONSUMES': return eng ? 'consumes messages from' : 'subscribes to';
    case 'QUERIES': return eng ? 'queries' : 'reads from';
    case 'USES': return 'uses';
    case 'DEPENDS_ON': return 'depends on';
    case 'CONTAINS': return 'contains';
    default: return type.toLowerCase().replace(/_/g, ' ');
  }
}

function collectCitations(flow: FlowGraph): readonly NarrationCitation[] {
  const cites: NarrationCitation[] = [];
  for (const n of flow.nodes) {
    if (!n.id) continue;
    cites.push({
      kind: 'graph',
      ref: n.id,
      excerpt: `${n.label}:${n.name || n.id}`,
    });
  }
  return cites;
}

function buildPrompt(flow: FlowGraph, skeleton: string, opts: NarrateOptions): string {
  const audience = opts.audience ?? 'engineer';
  // Defensive cap: serialise to JSON, truncate at ~3K tokens (~12K chars).
  const flowJson = JSON.stringify({
    seed: flow.seed,
    nodes: flow.nodes.slice(0, 80),
    edges: flow.edges.slice(0, 160),
    truncated: flow.truncated,
  });
  const flowSnippet = flowJson.length > NARRATION_MAX_INPUT_TOKENS * 4
    ? flowJson.slice(0, NARRATION_MAX_INPUT_TOKENS * 4) + '...'
    : flowJson;
  return [
    `Audience: ${audience}.`,
    'Polish this end-to-end flow into a concise narrative. Cite every claim by node id.',
    '',
    '## Deterministic skeleton',
    skeleton,
    '',
    '## FlowGraph (JSON, untrusted)',
    flowSnippet,
  ].join('\n');
}

function clampBullets(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 50);
}
