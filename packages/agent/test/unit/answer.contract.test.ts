import { describe, it, expect } from 'vitest';
import { validateAnswer, extractJson } from '../../src/answer.contract.js';
import { SeenIdSet } from '../../src/tools/tool.interface.js';

function seen(...ids: string[]): SeenIdSet {
  const s = new SeenIdSet();
  for (const id of ids) s.add(id);
  return s;
}

describe('validateAnswer', () => {
  it('rejects when retrieval is empty', () => {
    const r = validateAnswer({}, { seen: seen(), retrievalEmpty: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/REFUSE: no grounded retrieval/);
  });

  it('rejects malformed schema', () => {
    const r = validateAnswer(
      { answer: '', confidence: 'HIGH', citations: [] },
      { seen: seen('foo'), retrievalEmpty: false },
    );
    expect(r.ok).toBe(false);
  });

  it('rejects when no citations', () => {
    const r = validateAnswer(
      { answer: 'something', confidence: 'HIGH', citations: [] },
      { seen: seen('foo'), retrievalEmpty: false },
    );
    expect(r.ok).toBe(false);
  });

  it('rejects citations not in seen set', () => {
    const r = validateAnswer(
      { answer: 'x', confidence: 'HIGH', citations: [{ kind: 'code', ref: 'unseen-ref' }] },
      { seen: seen('something-else'), retrievalEmpty: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/citation/);
  });

  it('accepts when citation matches seen exactly', () => {
    const r = validateAnswer(
      { answer: 'x', confidence: 'HIGH', citations: [{ kind: 'graph', ref: 'Service:foo' }] },
      { seen: seen('Service:foo'), retrievalEmpty: false },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts loose citation match (substring of seen)', () => {
    const r = validateAnswer(
      { answer: 'x', confidence: 'MEDIUM', citations: [{ kind: 'code', ref: 'repo/path/file.ts:10-20' }] },
      { seen: seen('repo/path/file.ts'), retrievalEmpty: false },
    );
    expect(r.ok).toBe(true);
  });
});

describe('extractJson', () => {
  it('parses raw json', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses trailing prose', () => {
    expect(extractJson('Here it is: {"a":1} done')).toEqual({ a: 1 });
  });
  it('returns null for no json', () => {
    expect(extractJson('no json here')).toBeNull();
  });
});
