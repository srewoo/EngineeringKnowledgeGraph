import { describe, it, expect } from 'vitest';
import {
  FlowNarrator,
  renderSkeleton,
  type NarrationAgent,
  type NarrationAgentResult,
} from '../../src/flow.narrator.js';
import type { FlowGraph } from '../../src/flow.synthesis.js';

const sampleFlow: FlowGraph = {
  seed: { kind: 'route', value: '/api/v1/users' },
  nodes: [
    { id: 'svc:auth', label: 'Service', name: 'auth' },
    { id: 'api:users', label: 'API', name: 'users' },
    { id: 'tbl:users', label: 'Table', name: 'users' },
    { id: 'mq:user.created', label: 'MessageQueue', name: 'user.created' },
  ],
  edges: [
    { from: 'svc:auth', to: 'api:users', type: 'EXPOSES' },
    { from: 'svc:auth', to: 'tbl:users', type: 'QUERIES' },
    { from: 'svc:auth', to: 'mq:user.created', type: 'PRODUCES' },
  ],
  paths: [{ nodes: ['svc:auth', 'api:users'] }],
  truncated: false,
};

describe('renderSkeleton', () => {
  it('produces a deterministic English template walking edges', () => {
    const text = renderSkeleton(sampleFlow);
    expect(text).toContain('route:/api/v1/users');
    expect(text).toContain('exposes');
    expect(text).toContain('queries');
    expect(text).toContain('produces messages onto');
  });

  it('handles an empty flow gracefully', () => {
    const empty: FlowGraph = {
      seed: { kind: 'service', value: 'nothing' },
      nodes: [], edges: [], paths: [], truncated: false,
    };
    expect(renderSkeleton(empty)).toMatch(/No flow could be synthesized/);
  });

  it('respects maxBullets and notes elision', () => {
    const text = renderSkeleton(sampleFlow, { maxBullets: 1 });
    expect(text).toMatch(/more step/);
  });

  it('uses pm-tone verbs when audience=pm', () => {
    const text = renderSkeleton(sampleFlow, { audience: 'pm' });
    expect(text).toContain('publishes events to');
    expect(text).toContain('reads from');
  });
});

describe('FlowNarrator', () => {
  it('returns deterministic narration when agent is null', async () => {
    const narr = new FlowNarrator(null);
    const out = await narr.narrate(sampleFlow);
    expect(out.mode).toBe('deterministic');
    expect(out.text).toContain('route:/api/v1/users');
    // One citation per node.
    expect(out.citations).toHaveLength(sampleFlow.nodes.length);
    expect(out.citations[0]?.kind).toBe('graph');
  });

  it('uses the agent when provided and mode=llm', async () => {
    const fakeAgent: NarrationAgent = {
      async ask(_q): Promise<NarrationAgentResult> {
        return {
          status: 'ok',
          answer: { answer: 'Polished prose here.' },
          usage: { inputTokens: 120, outputTokens: 40 },
        };
      },
    };
    const narr = new FlowNarrator(fakeAgent);
    const out = await narr.narrate(sampleFlow, { audience: 'engineer' });
    expect(out.mode).toBe('llm');
    expect(out.text).toBe('Polished prose here.');
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(out.citations.length).toBe(sampleFlow.nodes.length);
  });

  it('falls back to deterministic when the agent refuses', async () => {
    const refusingAgent: NarrationAgent = {
      async ask(): Promise<NarrationAgentResult> {
        return { status: 'refused', refused: { reason: 'no retrieval' } };
      },
    };
    const narr = new FlowNarrator(refusingAgent);
    const out = await narr.narrate(sampleFlow);
    expect(out.mode).toBe('deterministic');
    expect(out.text).toContain('route:/api/v1/users');
  });
});
