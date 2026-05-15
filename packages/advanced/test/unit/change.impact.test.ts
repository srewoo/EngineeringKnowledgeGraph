import { describe, it, expect } from 'vitest';
import {
  analyzeImpact,
  clampDepth,
  IMPACT_MAX_DEPTH,
  type ImpactExecutor,
  type ImpactLabel,
  type RawImpactRow,
} from '../../src/change.impact.js';

describe('clampDepth', () => {
  it('clamps below 1', () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(-1)).toBe(1);
  });
  it('caps at IMPACT_MAX_DEPTH', () => {
    expect(clampDepth(IMPACT_MAX_DEPTH + 99)).toBe(IMPACT_MAX_DEPTH);
  });
  it('rejects NaN', () => {
    expect(clampDepth(Number.NaN)).toBe(1);
  });
  it('IMPACT_MAX_DEPTH is now 8 (raised from 4)', () => {
    expect(IMPACT_MAX_DEPTH).toBe(8);
    expect(clampDepth(8)).toBe(8);
    expect(clampDepth(7)).toBe(7);
  });
});

class StubExecutor implements ImpactExecutor {
  receivedLabel?: ImpactLabel;
  receivedDepth?: number;
  receivedPerLayer?: number;

  constructor(private readonly rows: readonly RawImpactRow[]) {}

  async query(label: ImpactLabel, _id: string, depth: number, perLayer: number): Promise<readonly RawImpactRow[]> {
    this.receivedLabel = label;
    this.receivedDepth = depth;
    this.receivedPerLayer = perLayer;
    return this.rows;
  }
}

describe('analyzeImpact', () => {
  it('separates direct (distance<=1) from transitive impact', async () => {
    const exec = new StubExecutor([
      { id: 'fn:a', label: 'Function', name: 'a', distance: 1, serviceName: 'svc-a', repoUrl: 'r1' },
      { id: 'fn:b', label: 'Function', name: 'b', distance: 2, serviceName: 'svc-a', repoUrl: 'r1' },
      { id: 'fn:c', label: 'Function', name: 'c', distance: 3, serviceName: 'svc-b', repoUrl: 'r2' },
    ]);
    const report = await analyzeImpact(exec, { label: 'Function', id: 'fn:target' });
    expect(report.directImpact.map((n) => n.id)).toEqual(['fn:a']);
    expect(report.transitiveImpact.map((n) => n.id)).toEqual(['fn:b', 'fn:c']);
  });

  it('aggregates by service and repo, sorted by count desc', async () => {
    const exec = new StubExecutor([
      { id: '1', label: 'Function', name: '1', distance: 1, serviceName: 'svc-a', repoUrl: 'r1' },
      { id: '2', label: 'Function', name: '2', distance: 2, serviceName: 'svc-a', repoUrl: 'r1' },
      { id: '3', label: 'Function', name: '3', distance: 2, serviceName: 'svc-b', repoUrl: 'r2' },
    ]);
    const report = await analyzeImpact(exec, { label: 'Function', id: 'fn:t' });
    expect(report.byService).toEqual({ 'svc-a': 2, 'svc-b': 1 });
    expect(report.byRepo).toEqual({ r1: 2, r2: 1 });
    expect(Object.keys(report.byService)).toEqual(['svc-a', 'svc-b']);
  });

  it('filters out the target node itself', async () => {
    const exec = new StubExecutor([
      { id: 'fn:target', label: 'Function', name: 't', distance: 0 },
      { id: 'fn:other', label: 'Function', name: 'o', distance: 1 },
    ]);
    const report = await analyzeImpact(exec, { label: 'Function', id: 'fn:target' });
    const allIds = [...report.directImpact, ...report.transitiveImpact].map((n) => n.id);
    expect(allIds).not.toContain('fn:target');
    expect(allIds).toContain('fn:other');
  });

  it('per-label traversal: passes label through to executor', async () => {
    const exec = new StubExecutor([]);
    await analyzeImpact(exec, { label: 'Column', id: 'col:x' });
    expect(exec.receivedLabel).toBe('Column');
    expect(exec.receivedDepth).toBe(IMPACT_MAX_DEPTH);
  });

  it('respects opts.maxHops up to the new ceiling of 8', async () => {
    const exec = new StubExecutor([]);
    await analyzeImpact(exec, { label: 'Function', id: 'fn:t' }, { maxHops: 8 });
    expect(exec.receivedDepth).toBe(8);
  });

  it('clamps maxHops above the ceiling', async () => {
    const exec = new StubExecutor([]);
    await analyzeImpact(exec, { label: 'Function', id: 'fn:t' }, { maxHops: 999 });
    expect(exec.receivedDepth).toBe(IMPACT_MAX_DEPTH);
  });

  it('omits serviceName/repoUrl when missing', async () => {
    const exec = new StubExecutor([
      { id: 'a', label: 'Function', name: 'a', distance: 1 },
    ]);
    const report = await analyzeImpact(exec, { label: 'Function', id: 't' });
    expect(report.directImpact[0]?.serviceName).toBeUndefined();
    expect(report.directImpact[0]?.repoUrl).toBeUndefined();
    expect(report.byService).toEqual({});
  });
});
