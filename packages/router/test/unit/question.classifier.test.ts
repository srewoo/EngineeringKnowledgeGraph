import { describe, it, expect } from 'vitest';
import { classify, type QuestionClass } from '../../src/question.classifier.js';

const CASES: ReadonlyArray<{ cls: QuestionClass; q: string }> = [
  // topology
  { cls: 'topology', q: 'What services depend on person-service?' },
  { cls: 'topology', q: 'Show me the consumers of the order pipeline' },
  { cls: 'topology', q: 'Reverse dependencies of auth-service please' },
  // schema
  { cls: 'schema', q: 'Which table stores user sessions?' },
  { cls: 'schema', q: 'Show me the database schema for billing' },
  { cls: 'schema', q: 'What migration introduced the tenants column?' },
  // code
  { cls: 'code', q: 'Where is calculateProficiencyScore implemented?' },
  { cls: 'code', q: 'Where do we compute the price discount?' },
  { cls: 'code', q: 'How is the ranking function defined?' },
  // flow
  { cls: 'flow', q: 'What happens end-to-end when a learner starts a course?' },
  { cls: 'flow', q: 'Walk me through the user flow for checkout' },
  { cls: 'flow', q: 'What happens when the user signs up via SSO?' },
  // ownership
  { cls: 'ownership', q: 'Who owns the AI prompt store?' },
  { cls: 'ownership', q: 'Who is the maintainer of person-service?' },
  { cls: 'ownership', q: 'Which team handles billing?' },
  // api
  { cls: 'api', q: 'Which endpoint creates a coaching session?' },
  { cls: 'api', q: 'Show me the GraphQL mutations for orders' },
  { cls: 'api', q: 'Which API returns user profile?' },
  // config
  { cls: 'config', q: 'Which env var controls Snowflake credentials?' },
  { cls: 'config', q: 'Where is the feature flag for dark mode set?' },
  { cls: 'config', q: 'Find the secret for the Stripe key' },
  // ops
  { cls: 'ops', q: 'Which Kafka topic does callAI consume?' },
  { cls: 'ops', q: 'Who is the producer of the orders queue?' },
  { cls: 'ops', q: 'What service consumes user-events?' },
  // history
  { cls: 'history', q: 'When did we add internal/external classification?' },
  { cls: 'history', q: 'History of the auth module' },
  { cls: 'history', q: 'When was the rate limiter first added?' },
];

describe('classify', () => {
  for (const c of CASES) {
    it(`classifies "${c.q}" as ${c.cls}`, () => {
      const out = classify(c.q);
      expect(out.class).toBe(c.cls);
      expect(out.confidence).toBeGreaterThan(0);
      expect(out.signals.length).toBeGreaterThan(0);
    });
  }

  it('returns unknown with confidence 0 for empty input', () => {
    expect(classify('').class).toBe('unknown');
    expect(classify('').confidence).toBe(0);
  });

  it('returns unknown for nonsensical input', () => {
    const r = classify('asdf qwerty zxcv');
    expect(r.class).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('lowers confidence to 0.3 for ambiguous multi-class hits', () => {
    // "schema" matches schema class; "endpoint" matches api class.
    const r = classify('Which endpoint touches the schema?');
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  it('breaks ties by priority order (topology beats schema when both match)', () => {
    // Contains both "uses" (topology) and "schema" (schema). Tie on count(1)
    // → topology wins by priority.
    const r = classify('which schema uses');
    expect(r.class).toBe('topology');
  });

  it('confidence stays >= 0.6 for clean single-class match', () => {
    const r = classify('Who owns the billing module?');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
