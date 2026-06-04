import { describe, it, expect } from 'vitest';
import { parseServiceDependencies } from '../../src/datadog/datadog.adapter.js';

describe('parseServiceDependencies', () => {
  it('returns [] for non-object input', () => {
    expect(parseServiceDependencies(null)).toEqual([]);
    expect(parseServiceDependencies(undefined)).toEqual([]);
    expect(parseServiceDependencies('not-json')).toEqual([]);
    expect(parseServiceDependencies(42)).toEqual([]);
  });

  it('parses Datadog v1 service_dependencies payload into edges', () => {
    const body = {
      'service-a': { calls: ['service-b', 'service-c'] },
      'service-b': { calls: ['service-d'] },
      'service-c': { calls: [] },
    };
    const edges = parseServiceDependencies(body);
    expect(edges).toEqual([
      { caller: 'service-a', callee: 'service-b' },
      { caller: 'service-a', callee: 'service-c' },
      { caller: 'service-b', callee: 'service-d' },
    ]);
  });

  it('filters self-loops and duplicates', () => {
    const body = {
      'foo': { calls: ['foo', 'bar', 'bar', '  '] },
    };
    expect(parseServiceDependencies(body)).toEqual([
      { caller: 'foo', callee: 'bar' },
    ]);
  });

  it('ignores entries without a calls array', () => {
    const body = {
      'orphan': { other: 'data' },
      'good': { calls: ['target'] },
    };
    expect(parseServiceDependencies(body)).toEqual([
      { caller: 'good', callee: 'target' },
    ]);
  });

  it('trims whitespace from callee names', () => {
    const body = { 'foo': { calls: ['  bar  '] } };
    expect(parseServiceDependencies(body)).toEqual([
      { caller: 'foo', callee: 'bar' },
    ]);
  });
});
