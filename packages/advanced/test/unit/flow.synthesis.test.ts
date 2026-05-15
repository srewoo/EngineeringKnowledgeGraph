import { describe, it, expect } from 'vitest';
import {
  buildFlowGraph,
  clampHops,
  synthesizeFlow,
  FLOW_MAX_HOPS,
  type FlowExecutor,
  type FlowSeed,
} from '../../src/flow.synthesis.js';

describe('clampHops', () => {
  it('clamps below 1 to 1', () => {
    expect(clampHops(0)).toBe(1);
    expect(clampHops(-5)).toBe(1);
  });
  it('clamps above hard ceiling', () => {
    expect(clampHops(FLOW_MAX_HOPS + 5)).toBe(FLOW_MAX_HOPS);
  });
  it('passes through valid integers', () => {
    expect(clampHops(7)).toBe(7);
  });
  it('floors floats and rejects NaN', () => {
    expect(clampHops(3.9)).toBe(3);
    expect(clampHops(Number.NaN)).toBe(1);
  });
});

describe('buildFlowGraph', () => {
  const seed: FlowSeed = { kind: 'service', value: 'auth' };

  it('dedups nodes and edges across paths', () => {
    const flow = buildFlowGraph(seed, [
      {
        nodes: [
          { id: 'svc:auth', label: 'Service', name: 'auth' },
          { id: 'fn:login', label: 'Function', name: 'login' },
          { id: 'api:billing/charge', label: 'API', name: 'charge' },
        ],
        rels: ['CONTAINS', 'CALLS_API'],
      },
      {
        // Same path again — should not duplicate.
        nodes: [
          { id: 'svc:auth', label: 'Service', name: 'auth' },
          { id: 'fn:login', label: 'Function', name: 'login' },
          { id: 'api:billing/charge', label: 'API', name: 'charge' },
        ],
        rels: ['CONTAINS', 'CALLS_API'],
      },
    ]);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.edges).toHaveLength(2);
    expect(flow.paths).toHaveLength(2);
  });

  it('skips empty rows and missing ids', () => {
    const flow = buildFlowGraph(seed, [
      { nodes: [], rels: [] },
      {
        nodes: [
          { id: '', label: 'Service', name: 'ghost' },
          { id: 'svc:b', label: 'Service', name: 'b' },
        ],
        rels: ['DEPENDS_ON'],
      },
    ]);
    expect(flow.nodes.map((n) => n.id)).toEqual(['svc:b']);
    expect(flow.edges).toEqual([]);
  });

  it('omits kind when empty string', () => {
    const flow = buildFlowGraph(seed, [
      {
        nodes: [
          { id: 'a', label: 'Service', name: 'a', kind: '' },
          { id: 'b', label: 'Service', name: 'b', kind: 'http' },
        ],
        rels: ['DEPENDS_ON'],
      },
    ]);
    const a = flow.nodes.find((n) => n.id === 'a');
    const b = flow.nodes.find((n) => n.id === 'b');
    expect(a?.kind).toBe('');
    expect(b?.kind).toBe('http');
  });
});

describe('synthesizeFlow', () => {
  it('invokes executor with clamped hop count', async () => {
    let received = 0;
    const exec: FlowExecutor = {
      async walk(_seed, hops) {
        received = hops;
        return [];
      },
    };
    await synthesizeFlow(exec, { kind: 'service', value: 'x' }, { maxHops: 99 });
    expect(received).toBe(FLOW_MAX_HOPS);
  });

  it('defaults includeKafka to true', async () => {
    let received: boolean | undefined;
    const exec: FlowExecutor = {
      async walk(_seed, _hops, includeKafka) {
        received = includeKafka;
        return [];
      },
    };
    await synthesizeFlow(exec, { kind: 'service', value: 'x' });
    expect(received).toBe(true);
  });
});
