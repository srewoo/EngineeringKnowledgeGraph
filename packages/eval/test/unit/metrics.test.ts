import { describe, it, expect } from 'vitest';
import { citationOverlap, faithfulness, average } from '../../src/metrics.js';

describe('citationOverlap', () => {
  it('perfect overlap', () => {
    const r = citationOverlap(['A', 'B'], ['A', 'B']);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
  });

  it('no overlap', () => {
    const r = citationOverlap(['X'], ['Y']);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
  });

  it('partial: predicted superset of gold', () => {
    const r = citationOverlap(['A', 'B', 'C'], ['A']);
    expect(r.truePositives).toBe(1);
    expect(r.falsePositives).toBe(2);
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.recall).toBe(1);
  });

  it('trims whitespace and ignores blanks', () => {
    const r = citationOverlap(['  A  ', '', '  '], [' A ']);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
  });

  it('empty predicted with non-empty gold returns 0/0', () => {
    const r = citationOverlap([], ['A']);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
  });

  it('both empty returns precision=1 recall=1', () => {
    const r = citationOverlap([], []);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
  });
});

describe('faithfulness', () => {
  it('every sentence with [ref:...] marker is supported', () => {
    const a = 'First claim [ref:A]. Second claim [ref:B].';
    expect(faithfulness(a, ['A', 'B'])).toBe(1);
  });

  it('substring-of-citation supports a sentence', () => {
    const a = 'The Service:auth-service handles login. It uses JWTs.';
    // first sentence supported by citation substring; second is not.
    expect(faithfulness(a, ['Service:auth-service'])).toBeCloseTo(0.5);
  });

  it('zero when no citations and no markers', () => {
    expect(faithfulness('A. B. C.', [])).toBe(0);
  });

  it('empty answer → 0', () => {
    expect(faithfulness('', ['A'])).toBe(0);
  });
});

describe('average', () => {
  it('averages numbers', () => {
    expect(average([1, 2, 3, 4])).toBe(2.5);
  });
  it('empty returns 0', () => {
    expect(average([])).toBe(0);
  });
});
