import { describe, it, expect } from 'vitest';
import { selectStrategy } from '../../src/strategy.selector.js';

describe('selectStrategy', () => {
  it('topology → graph-only/topology', () => {
    expect(selectStrategy('topology')).toEqual({ kind: 'graph-only', cypher: 'topology' });
  });
  it('schema → graph-then-hybrid/Table', () => {
    expect(selectStrategy('schema')).toEqual({ kind: 'graph-then-hybrid', label: 'Table' });
  });
  it('code → hybrid/Function/expandGraph', () => {
    expect(selectStrategy('code')).toEqual({ kind: 'hybrid', label: 'Function', expandGraph: true });
  });
  it('flow → multi-hop/API', () => {
    expect(selectStrategy('flow')).toEqual({ kind: 'multi-hop', startLabel: 'API' });
  });
  it('ownership → graph-only/ownership', () => {
    expect(selectStrategy('ownership')).toEqual({ kind: 'graph-only', cypher: 'ownership' });
  });
  it('api → hybrid/API', () => {
    expect(selectStrategy('api')).toEqual({ kind: 'hybrid', label: 'API' });
  });
  it('config → graph-only/config', () => {
    expect(selectStrategy('config')).toEqual({ kind: 'graph-only', cypher: 'config' });
  });
  it('ops → graph-only/kafka', () => {
    expect(selectStrategy('ops')).toEqual({ kind: 'graph-only', cypher: 'kafka' });
  });
  it('history → graph-only/commits', () => {
    expect(selectStrategy('history')).toEqual({ kind: 'graph-only', cypher: 'commits' });
  });
  it('unknown → broad hybrid (no label)', () => {
    expect(selectStrategy('unknown')).toEqual({ kind: 'hybrid' });
  });
});
