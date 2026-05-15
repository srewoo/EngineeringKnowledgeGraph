import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval } from '../../src/eval.runner.js';
import type { EvalAgent, EvalAgentResult } from '../../src/eval.runner.js';
import type { EvalCase } from '../../src/eval.types.js';

const FIXTURE: readonly EvalCase[] = [
  {
    id: 'c1', question: 'What services depend on auth-service?',
    expectedClass: 'topology', goldCitations: ['Service:auth-service'],
  },
  {
    id: 'c2', question: 'Which table column marks internal users?',
    expectedClass: 'schema', goldCitations: ['Table:User', 'Column:User.is_internal'],
  },
  {
    id: 'c3', question: 'Where is rate limiting implemented?',
    expectedClass: 'code', goldCitations: ['repo:gateway:src/rate.ts:1-20'],
  },
  {
    id: 'c4', question: 'Which kafka topic is consumed by callAI?',
    expectedClass: 'ops', goldCitations: ['Topic:calls.completed'],
  },
  {
    id: 'c5', question: 'Who owns the prompt store?',
    expectedClass: 'ownership', goldCitations: ['Team:platform-ai'],
  },
];

class GoldAgent implements EvalAgent {
  async ask(_q: string): Promise<EvalAgentResult> {
    void _q;
    return {
      status: 'ok',
      answer: 'The Service:auth-service is used [ref:Service:auth-service].',
      citations: ['Service:auth-service', 'Table:User', 'Column:User.is_internal',
        'repo:gateway:src/rate.ts:1-20', 'Topic:calls.completed', 'Team:platform-ai'],
    };
  }
}

class RefuseAgent implements EvalAgent {
  async ask(_q: string): Promise<EvalAgentResult> {
    void _q;
    return { status: 'refused', citations: [], refuseReason: 'no retrieval' };
  }
}

describe('runEval', () => {
  it('aggregates a 5-case run with a gold-mock agent', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ekg-eval-test-'));
    try {
      const { run, perCase } = await runEval(FIXTURE, new GoldAgent(), { outDir: out });
      expect(run.cases).toBe(5);
      expect(run.classifierAcc).toBeGreaterThan(0.5);
      expect(run.citationRecall).toBeGreaterThan(0);
      // Trace JSONL written
      const trace = readFileSync(join(out, 'cases.jsonl'), 'utf8').trim().split('\n');
      expect(trace).toHaveLength(5);
      // Per-case shapes
      for (const r of perCase) {
        expect(r.id).toBeTruthy();
        expect(typeof r.precision).toBe('number');
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('records refusals without crashing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ekg-eval-test-'));
    try {
      const { run, perCase } = await runEval(FIXTURE, new RefuseAgent(), { outDir: out });
      expect(run.passed).toBe(0);
      expect(perCase.every((c) => c.status === 'refused')).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('null agent yields retrieval-only run with zero citation metrics', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ekg-eval-test-'));
    try {
      const { run, perCase } = await runEval(FIXTURE, null, { outDir: out });
      expect(run.citationPrecision).toBe(0);
      expect(perCase.every((c) => c.status === 'refused')).toBe(true);
      // classifier accuracy should still be meaningful
      expect(run.classifierAcc).toBeGreaterThan(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('respects --limit', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ekg-eval-test-'));
    try {
      const { run } = await runEval(FIXTURE, new GoldAgent(), { outDir: out, limit: 2 });
      expect(run.cases).toBe(2);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('uses optional fluency judge when supplied', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ekg-eval-test-'));
    try {
      const judge = async (): Promise<number> => 0.9;
      const { run } = await runEval(FIXTURE, new GoldAgent(), { outDir: out, judge });
      expect(run.answerRelevance).toBeCloseTo(0.9);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
