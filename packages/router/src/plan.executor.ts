/**
 * Plan executor — runs the chosen retrieval strategy and returns ranked
 * results plus a routing trace. Pure dispatch over strategy kinds; no LLM
 * here (LLM lives in question.classifier fallback path only).
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { HybridSearch, HybridResult } from '@ekg/search';
import type { Neo4jClient } from '@ekg/graph';
import type { QuestionClass } from './question.classifier.js';
import type { RetrievalStrategy, CypherTemplateKey, CompositeStrategy } from './strategy.selector.js';
import { extractServiceNames, getTemplate } from './cypher.templates.js';

export interface PlanResult {
  readonly question: string;
  readonly class: QuestionClass;
  readonly strategy: RetrievalStrategy;
  readonly entities: { readonly serviceNames: readonly string[] };
  readonly results: {
    readonly graph?: readonly Record<string, unknown>[];
    readonly hybrid?: readonly HybridResult[];
    readonly multiHop?: {
      readonly seeds: readonly Record<string, unknown>[];
      readonly hybrid: readonly HybridResult[];
    };
  };
  readonly sources: readonly string[];
  readonly duration_ms: number;
  readonly notes: readonly string[];
}

export interface PlanExecutorDeps {
  readonly hybrid: HybridSearch;
  readonly neo4j: Neo4jClient;
}

export interface ExecuteOptions {
  readonly k?: number;
  readonly repoUrl?: string;
}

const MULTI_HOP_DEPTH = 2;
const MULTI_HOP_LIMIT = 25;

export async function executePlan(
  question: string,
  cls: QuestionClass,
  strategy: RetrievalStrategy,
  deps: PlanExecutorDeps,
  opts: ExecuteOptions = {},
): Promise<PlanResult> {
  const logger: Logger = createLogger({ service: 'plan-executor' });
  const start = Date.now();
  const serviceNames = extractServiceNames(question);
  const notes: string[] = [];
  const sources: string[] = [];
  const k = Math.max(1, Math.min(opts.k ?? 10, 50));

  logger.info({ class: cls, kind: strategy.kind, serviceNames, k }, 'Executing plan');

  const result: PlanResult = {
    question,
    class: cls,
    strategy,
    entities: { serviceNames },
    results: {},
    sources,
    duration_ms: 0,
    notes,
  };

  try {
    if (strategy.kind === 'graph-only') {
      const graph = await runGraph(strategy.cypher, serviceNames, question, deps, logger);
      sources.push(`graph:${strategy.cypher ?? 'unknown'}`);
      mut(result).results = { graph };
      if (strategy.cypher === 'commits' && graph.length === 0) {
        notes.push('No commits found — set EKG_GIT_HISTORY_ENABLED=true and re-ingest to populate Commit nodes.');
      }
    } else if (strategy.kind === 'hybrid') {
      const hybrid = await runHybrid(question, strategy.label, opts.repoUrl, k, deps, logger);
      sources.push('hybrid');
      mut(result).results = { hybrid };
    } else if (strategy.kind === 'graph-then-hybrid') {
      const hybridLabel = strategy.label ?? 'Table';
      const seedQuery = `
        MATCH (n:${sanitizeLabel(hybridLabel)})
        WHERE toLower(n.name) CONTAINS $needle
        RETURN n.id AS id, labels(n)[0] AS label, coalesce(n.name, '') AS name
        LIMIT 25
      `.trim();
      const needle = (serviceNames[0] ?? firstWord(question)).toLowerCase();
      const graph = await runGraphRaw(seedQuery, { needle }, deps, logger);
      sources.push(`graph:${hybridLabel}-lookup`);
      if (graph.length === 0) {
        const hybrid = await runHybrid(question, hybridLabel, opts.repoUrl, k, deps, logger);
        sources.push('hybrid (fallback)');
        notes.push('Graph lookup returned 0 rows; falling back to hybrid search.');
        mut(result).results = { graph, hybrid };
      } else {
        mut(result).results = { graph };
      }
    } else if (strategy.kind === 'multi-hop') {
      const startLabel = sanitizeLabel(strategy.startLabel ?? 'API');
      const cypher = `
        MATCH (s:${startLabel})
        WHERE toLower(coalesce(s.name, '')) CONTAINS $needle
           OR toLower(coalesce(s.path, '')) CONTAINS $needle
        OPTIONAL MATCH path = (s)-[:CALLS|CALLS_API|EXPOSES|USES*1..${MULTI_HOP_DEPTH}]->(t)
        RETURN s.id AS startId, coalesce(s.name, '') AS startName,
               collect(DISTINCT { id: coalesce(t.id, ''), label: coalesce(labels(t)[0], ''), name: coalesce(t.name, '') })[..${MULTI_HOP_LIMIT}] AS terminals
        LIMIT ${MULTI_HOP_LIMIT}
      `.trim();
      const needle = firstWord(question).toLowerCase();
      const seeds = await runGraphRaw(cypher, { needle }, deps, logger);
      const hybrid = await runHybrid(question, undefined, opts.repoUrl, k, deps, logger);
      sources.push(`graph:multi-hop@${startLabel}`, 'hybrid');
      mut(result).results = { multiHop: { seeds, hybrid } };
    }
  } catch (err) {
    logger.error({ err: errMsg(err), class: cls, kind: strategy.kind }, 'Plan execution failed');
    notes.push(`execution-error: ${errMsg(err)}`);
  }

  mut(result).duration_ms = Date.now() - start;
  logger.info({ class: cls, ms: result.duration_ms, sources }, 'Plan executed');
  return result;
}

async function runGraph(
  key: CypherTemplateKey | undefined,
  serviceNames: readonly string[],
  question: string,
  deps: PlanExecutorDeps,
  logger: Logger,
): Promise<readonly Record<string, unknown>[]> {
  if (!key) return [];
  const tpl = getTemplate(key);
  const params: Record<string, unknown> = {
    serviceNames: serviceNames.map((s) => s.toLowerCase()),
  };
  if (key === 'commits' || key === 'coverage') {
    params['entity'] = extractFilePathHint(question);
  }
  if (key === 'config') {
    // Allow either a file-path hint or an UPPER_SNAKE env-var name to scope
    // the ConfigKey lookup. Empty string lets the template fall back to the
    // service-name path.
    params['entity'] = extractConfigEntityHint(question);
  }
  if (key === 'mrs') {
    // MRs can be addressed by projectPath substring, author username, or
    // title keyword. Fall through to free-form: pick the first non-stopword
    // token if no path-like hint is present.
    const path = extractFilePathHint(question);
    params['entity'] = path || extractFreeformEntity(question);
  }
  if (key === 'runtime') {
    // No entity needed — runtime template keys off serviceNames alone.
  }
  return runGraphRaw(tpl.cypher, params, deps, logger);
}

/**
 * Pull a file-path-shaped token out of a history question, e.g.
 * "when did we change apps/web/src/index.ts?" → "apps/web/src/index.ts".
 * Returns "" when nothing matches — the template tolerates an empty entity
 * and falls back to the service-name path.
 */
function extractFilePathHint(question: string): string {
  // Match tokens that look like a/b/c or a/b/c.ext
  const m = question.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,}/);
  return m ? m[0] : '';
}

/**
 * Pick the most plausible config-entity token: an UPPER_SNAKE env-var name
 * (e.g. `DATABASE_URL`) or, failing that, a file-path hint. Returns "".
 */
function extractConfigEntityHint(question: string): string {
  const env = question.match(/\b[A-Z][A-Z0-9_]{3,}\b/);
  if (env) return env[0];
  return extractFilePathHint(question);
}

/**
 * Pull the first plausible identifier from a free-form question — e.g.
 * the username in "MRs by alice", or the keyword in "MRs about billing".
 * Drops common stopwords + question words.
 */
const FREEFORM_STOPWORDS = new Set([
  'mrs', 'mr', 'pr', 'prs', 'merge', 'pull', 'request', 'requests',
  'by', 'from', 'about', 'on', 'in', 'the', 'a', 'an', 'this', 'that',
  'who', 'what', 'which', 'when', 'where', 'show', 'list', 'find',
  'authored', 'reviewed', 'approved', 'merged',
]);
function extractFreeformEntity(question: string): string {
  for (const tok of question.toLowerCase().split(/\s+/)) {
    const clean = tok.replace(/[^a-z0-9_-]/g, '');
    if (clean.length < 3) continue;
    if (FREEFORM_STOPWORDS.has(clean)) continue;
    return clean;
  }
  return '';
}

async function runGraphRaw(
  cypher: string,
  params: Record<string, unknown>,
  deps: PlanExecutorDeps,
  logger: Logger,
): Promise<readonly Record<string, unknown>[]> {
  const t0 = Date.now();
  try {
    const rows = await deps.neo4j.executeRead(async (tx) => {
      const r = await tx.run(cypher, params);
      return r.records.map((rec) => rec.toObject() as Record<string, unknown>);
    });
    logger.info({ ms: Date.now() - t0, rows: rows.length }, 'Graph query done');
    return rows;
  } catch (err) {
    logger.warn({ err: errMsg(err) }, 'Graph query failed');
    return [];
  }
}

async function runHybrid(
  query: string,
  label: string | undefined,
  repoUrl: string | undefined,
  k: number,
  deps: PlanExecutorDeps,
  logger: Logger,
): Promise<readonly HybridResult[]> {
  const t0 = Date.now();
  const out = await deps.hybrid.search(query, {
    ...(label ? { label } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    k,
  });
  logger.info({ ms: Date.now() - t0, hits: out.length, label }, 'Hybrid search done');
  return out;
}

function sanitizeLabel(label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
    throw new Error(`Invalid Neo4j label: ${label}`);
  }
  return label;
}

function firstWord(q: string): string {
  const m = q.match(/[A-Za-z][A-Za-z0-9-]*/);
  return m ? m[0] : '';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------------------
// Phase F: composite plan execution.
//
// A composite plan is the answer to compound questions like
// "is payment-service slow because of code or load?" — a single user turn
// that needs to consult multiple retrieval strategies and reconcile.
//
// Execution model:
//   - Each sub-strategy runs through executePlan() in parallel via
//     Promise.allSettled — one slow sub-plan can't stall the rest, and one
//     failing sub-plan can't take down the whole turn.
//   - Result envelope keeps each sub-plan's own `PlanResult` intact so the
//     agent can cite per-source rather than seeing a merged blob.
//   - Sources, notes are merged + deduped for cheap top-level inspection.
// -------------------------------------------------------------------------

export interface CompositePlanResult {
  readonly question: string;
  readonly primaryClass: QuestionClass;
  readonly secondaryClasses: readonly QuestionClass[];
  readonly subPlans: readonly { readonly class: QuestionClass; readonly result: PlanResult }[];
  readonly sources: readonly string[];
  readonly notes: readonly string[];
  readonly duration_ms: number;
}

export async function executeCompositePlan(
  question: string,
  primaryClass: QuestionClass,
  composite: CompositeStrategy,
  deps: PlanExecutorDeps,
  opts: ExecuteOptions = {},
): Promise<CompositePlanResult> {
  const logger: Logger = createLogger({ service: 'plan-executor.composite' });
  const start = Date.now();

  logger.info({
    primary: primaryClass,
    subCount: composite.subStrategies.length,
  }, 'Executing composite plan');

  const settled = await Promise.allSettled(
    composite.subStrategies.map((sub) =>
      executePlan(question, sub.class, sub.strategy, deps, opts),
    ),
  );

  const subPlans: { class: QuestionClass; result: PlanResult }[] = [];
  const sources = new Set<string>();
  const notes: string[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const sub = composite.subStrategies[i]!;
    const outcome = settled[i]!;
    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      subPlans.push({ class: sub.class, result: r });
      for (const s of r.sources) sources.add(s);
      for (const n of r.notes) notes.push(`[${sub.class}] ${n}`);
    } else {
      // Don't synthesise a fake PlanResult — preserve the failure as a note.
      notes.push(`[${sub.class}] sub-plan failed: ${errMsg(outcome.reason)}`);
    }
  }

  const duration = Date.now() - start;
  logger.info({
    primary: primaryClass,
    subSuccess: subPlans.length,
    subFail: composite.subStrategies.length - subPlans.length,
    duration_ms: duration,
  }, 'Composite plan complete');

  const secondaryClasses = composite.subStrategies
    .map((s) => s.class)
    .filter((c) => c !== primaryClass);

  return {
    question,
    primaryClass,
    secondaryClasses,
    subPlans,
    sources: [...sources],
    notes,
    duration_ms: duration,
  };
}

/**
 * Helper for callers that have a `ClassificationResult` in hand: decides
 * whether to dispatch a composite or single plan. The threshold is
 * intentionally conservative — single-class plans are cheaper and easier
 * to cite, so we only compose when the classifier clearly saw multiple
 * intents.
 */
export function shouldUseCompositePlan(
  primary: QuestionClass,
  secondaryClasses: readonly QuestionClass[],
  confidence: number,
): boolean {
  if (secondaryClasses.length === 0) return false;
  if (primary === 'unknown') return false;
  // Composite kicks in when the primary is ambiguous (low confidence) OR
  // when more than one other class lit up — meaning the question genuinely
  // spans intents.
  return confidence <= 0.5 || secondaryClasses.length >= 2;
}

// `PlanResult` fields are readonly for callers; we mutate during construction.
function mut<T>(o: T): { -readonly [K in keyof T]: T[K] } {
  return o as { -readonly [K in keyof T]: T[K] };
}
