import { describe, it, expect } from 'vitest';
import { renderSequenceDiagram } from '../../src/mermaid.renderer.js';
import type { FlowGraph } from '../../src/flow.synthesis.js';

const tinyFlow: FlowGraph = {
  seed: { kind: 'service', value: 'auth' },
  nodes: [
    { id: 'svc:auth', label: 'Service', name: 'auth' },
    { id: 'fn:login', label: 'Function', name: 'login' },
    { id: 'api:billing/charge', label: 'API', name: 'charge' },
  ],
  edges: [
    { from: 'svc:auth', to: 'fn:login', type: 'CONTAINS' },
    { from: 'fn:login', to: 'api:billing/charge', type: 'CALLS_API' },
  ],
  paths: [{ nodes: ['svc:auth', 'fn:login', 'api:billing/charge'] }],
  truncated: false,
};

describe('renderSequenceDiagram', () => {
  it('emits sequenceDiagram header and participants', () => {
    const out = renderSequenceDiagram(tinyFlow, { title: 'auth flow' });
    expect(out.startsWith('sequenceDiagram')).toBe(true);
    expect(out).toContain('title auth flow');
    expect(out).toContain('participant');
    expect(out).toContain('CONTAINS');
    expect(out).toContain('CALLS_API');
  });

  it('truncates and adds note when over caps', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`, label: 'Service', name: `s${i}`,
    }));
    const edges = Array.from({ length: 200 }, (_, i) => ({
      from: `n${i % 100}`,
      to: `n${(i + 1) % 100}`,
      type: 'DEPENDS_ON',
    }));
    const flow: FlowGraph = {
      seed: { kind: 'service', value: 'big' },
      nodes,
      edges,
      paths: [],
      truncated: true,
    };
    const out = renderSequenceDiagram(flow, { maxActors: 10, maxMessages: 20 });
    const participantCount = (out.match(/^\s*participant /gm) ?? []).length;
    const messageCount = (out.match(/->>/g) ?? []).length;
    expect(participantCount).toBe(10);
    expect(messageCount).toBeLessThanOrEqual(20);
    expect(out).toMatch(/truncated/);
  });

  it('sanitises participant ids', () => {
    const flow: FlowGraph = {
      seed: { kind: 'service', value: 'x' },
      nodes: [
        { id: 'a', label: 'Service', name: 'with spaces & symbols!' },
        { id: 'b', label: 'API', name: '/v1/path' },
      ],
      edges: [{ from: 'a', to: 'b', type: 'CALLS_API' }],
      paths: [],
      truncated: false,
    };
    const out = renderSequenceDiagram(flow);
    // No raw spaces or slashes in participant identifier line.
    const participantLines = out.split('\n').filter((l) => l.includes('participant'));
    for (const line of participantLines) {
      const id = line.trim().split(/\s+/)[1];
      expect(id).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});
