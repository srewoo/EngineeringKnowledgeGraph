/**
 * Strategy selector — pure data table mapping question classes to retrieval
 * strategies. No switch statements: a frozen lookup map keeps additions trivial.
 */

import type { QuestionClass } from './question.classifier.js';

export type StrategyKind = 'graph-only' | 'hybrid' | 'graph-then-hybrid' | 'multi-hop';

export type CypherTemplateKey = 'topology' | 'ownership' | 'config' | 'kafka' | 'commits';

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
  unknown:   { kind: 'hybrid' },
});

export function selectStrategy(cls: QuestionClass): RetrievalStrategy {
  return STRATEGY_TABLE[cls];
}

export function strategyTable(): Readonly<Record<QuestionClass, RetrievalStrategy>> {
  return STRATEGY_TABLE;
}
