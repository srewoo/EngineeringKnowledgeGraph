/**
 * Strategy selector — pure data table mapping question classes to retrieval
 * strategies. No switch statements: a frozen lookup map keeps additions trivial.
 */

import type { QuestionClass } from './question.classifier.js';

export type StrategyKind = 'graph-only' | 'hybrid' | 'graph-then-hybrid' | 'multi-hop' | 'graph-and-hybrid';

export type CypherTemplateKey =
  | 'topology' | 'ownership' | 'config' | 'kafka' | 'commits'
  // Phase F additions — new graph surfaces from Phases B/C/E.
  | 'runtime' | 'coverage' | 'mrs';

export interface RetrievalStrategy {
  readonly kind: StrategyKind;
  readonly cypher?: CypherTemplateKey;
  readonly label?: string;
  readonly startLabel?: string;
  readonly expandGraph?: boolean;
}

const STRATEGY_TABLE: Readonly<Record<QuestionClass, RetrievalStrategy>> = Object.freeze({
  topology:  { kind: 'graph-only',         cypher: 'topology' },
  schema:    { kind: 'graph-then-hybrid',  label: 'Table' },
  code:      { kind: 'hybrid',             label: 'Function', expandGraph: true },
  flow:      { kind: 'multi-hop',          startLabel: 'API' },
  ownership: { kind: 'graph-only',         cypher: 'ownership' },
  api:       { kind: 'hybrid',             label: 'API' },
  config:    { kind: 'graph-only',         cypher: 'config' },
  ops:       { kind: 'graph-only',         cypher: 'kafka' },
  history:   { kind: 'graph-only',         cypher: 'commits' },
  // Phase F additions
  runtime:   { kind: 'graph-only',         cypher: 'runtime' },
  coverage:  { kind: 'graph-only',         cypher: 'coverage' },
  mr:        { kind: 'graph-only',         cypher: 'mrs' },
  // "semantic" — pure hybrid (vector + BM25). Label intentionally absent so
  // the search isn't pinned to one node type; the agent gets back the best
  // semantic matches across labels.
  semantic:  { kind: 'hybrid' },
  unknown:   { kind: 'hybrid' },
});

export function selectStrategy(cls: QuestionClass): RetrievalStrategy {
  return STRATEGY_TABLE[cls];
}

export function strategyTable(): Readonly<Record<QuestionClass, RetrievalStrategy>> {
  return STRATEGY_TABLE;
}

/**
 * Phase F: composite plan over multiple classes — runs each sub-strategy
 * in parallel and merges results. Caller picks when to use this (e.g. when
 * `ClassificationResult.secondaryClasses` is non-empty *and* confidence on
 * the primary is low, signalling a genuinely compound question).
 */
export interface CompositeStrategy {
  readonly kind: 'composite';
  readonly subStrategies: readonly Readonly<{ readonly class: QuestionClass; readonly strategy: RetrievalStrategy }>[];
}

export function selectCompositeStrategy(
  primary: QuestionClass,
  secondary: readonly QuestionClass[],
): CompositeStrategy {
  const seen = new Set<QuestionClass>();
  const subs: Array<{ class: QuestionClass; strategy: RetrievalStrategy }> = [];
  for (const cls of [primary, ...secondary]) {
    if (seen.has(cls)) continue;
    seen.add(cls);
    subs.push({ class: cls, strategy: STRATEGY_TABLE[cls] });
  }
  return { kind: 'composite', subStrategies: subs };
}
