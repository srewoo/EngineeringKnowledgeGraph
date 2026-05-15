/**
 * Rule-first question classifier.
 *
 * Pure function. No LLM, no I/O. Pattern lists per class, with priority order
 * resolving ties. Confidence: 0.6+ for clean single-class match, 0.3 if
 * multi-class match, 0 for unknown.
 */

export type QuestionClass =
  | 'topology'
  | 'schema'
  | 'code'
  | 'flow'
  | 'ownership'
  | 'api'
  | 'config'
  | 'ops'
  | 'history'
  | 'unknown';

export interface ClassificationResult {
  readonly class: QuestionClass;
  readonly confidence: number;
  readonly signals: readonly string[];
}

interface Rule {
  readonly cls: QuestionClass;
  readonly patterns: readonly RegExp[];
}

// Priority order (higher index = lower priority for tie-breaking).
const RULES: readonly Rule[] = [
  {
    cls: 'topology',
    patterns: [
      /\bdepends? on\b/i,
      /\b(uses|using)\b/i,
      /\bconsumers? of\b/i,
      /\bcallers? of\b/i,
      /\bservices? that (call|use)\b/i,
      /\breverse dep(endenc(y|ies))?\b/i,
      /\bwhat services\b/i,
    ],
  },
  {
    cls: 'schema',
    patterns: [
      /\bwhich (table|column|field)\b/i,
      /\bdatabase\b/i,
      /\bschema\b/i,
      /\bmodel\b/i,
      /\bmigration\b/i,
    ],
  },
  {
    cls: 'api',
    patterns: [
      /\bwhich (endpoint|api|route)\b/i,
      /\bswagger\b/i,
      /\bopenapi\b/i,
      /\bgraphql\b/i,
      /\brest (api|endpoint)\b/i,
    ],
  },
  {
    cls: 'flow',
    patterns: [
      /\bend-?to-?end\b/i,
      /\buser (flow|journey)\b/i,
      /\bwhen .* (clicks|starts|signs|submits|logs in)\b/i,
      /\bwhat happens when\b/i,
    ],
  },
  {
    cls: 'ownership',
    patterns: [
      /\bwho owns\b/i,
      /\bowners?\b/i,
      /\bteam\b/i,
      /\bmaintainer\b/i,
    ],
  },
  {
    cls: 'config',
    patterns: [
      /\benv(ironment)? var(iable)?\b/i,
      /\bsecret\b/i,
      /\bconfig\b/i,
      /\bfeature flag\b/i,
    ],
  },
  {
    cls: 'ops',
    patterns: [
      /\bkafka topic\b/i,
      /\bqueue\b/i,
      /\bproducer\b/i,
      /\bconsumer\b/i,
      /\bconsumes\b/i,
      /\bproduces\b/i,
    ],
  },
  {
    cls: 'history',
    patterns: [
      /\bwhen did\b/i,
      /\bhistory\b/i,
      /\bfirst added\b/i,
      /\bintroduced\b/i,
    ],
  },
  {
    cls: 'code',
    patterns: [
      /\bwhere (is|do|does).*(implement|defined|calculate|compute)/i,
      /\bfunction\b/i,
      /\bmethod\b/i,
      /\bhow is .* implemented\b/i,
    ],
  },
];

interface Hit {
  readonly cls: QuestionClass;
  readonly count: number;
  readonly signals: readonly string[];
  readonly priority: number;
}

export function classify(question: string): ClassificationResult {
  const q = question.trim();
  if (q.length === 0) {
    return { class: 'unknown', confidence: 0, signals: [] };
  }

  const hits: Hit[] = [];
  RULES.forEach((rule, priority) => {
    const matched: string[] = [];
    for (const p of rule.patterns) {
      const m = q.match(p);
      if (m) matched.push(m[0]);
    }
    if (matched.length > 0) {
      hits.push({ cls: rule.cls, count: matched.length, signals: matched, priority });
    }
  });

  if (hits.length === 0) {
    return { class: 'unknown', confidence: 0, signals: [] };
  }

  // Highest match-count wins; ties resolved by priority (lower index wins).
  hits.sort((a, b) => (b.count - a.count) || (a.priority - b.priority));
  const winner = hits[0]!;
  const distinctClasses = new Set(hits.map((h) => h.cls));
  const confidence = distinctClasses.size > 1 ? 0.3 : Math.min(0.6 + 0.1 * (winner.count - 1), 0.95);

  return {
    class: winner.cls,
    confidence: Number(confidence.toFixed(2)),
    signals: winner.signals,
  };
}
