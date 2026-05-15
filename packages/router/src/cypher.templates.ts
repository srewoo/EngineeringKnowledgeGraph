/**
 * Pre-built parameterised Cypher templates per strategy key.
 *
 * All queries cap traversal depth at 3 and limit output. Service-name
 * extraction is intentionally naive — a heuristic, not NER.
 */

import type { CypherTemplateKey } from './strategy.selector.js';

const SERVICE_NAME_RE = /\b([a-z][a-z0-9]+(?:-[a-z0-9]+)*(?:-(?:ui|service|api|gql|cli))?)\b/g;

const STOPWORDS: ReadonlySet<string> = new Set([
  'what', 'which', 'who', 'when', 'where', 'how', 'why',
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'did',
  'on', 'in', 'of', 'to', 'for', 'and', 'or', 'with',
  'depends', 'depend', 'uses', 'using', 'use', 'consumers', 'consumer',
  'callers', 'caller', 'services', 'service', 'that', 'call', 'calls',
  'reverse', 'dep', 'deps', 'database', 'databases', 'schema', 'model',
  'migration', 'table', 'tables', 'column', 'columns', 'field', 'fields',
  'endpoint', 'endpoints', 'api', 'apis', 'route', 'routes', 'swagger',
  'openapi', 'graphql', 'rest', 'env', 'environment', 'var', 'variable',
  'secret', 'secrets', 'config', 'feature', 'flag', 'flags',
  'kafka', 'topic', 'topics', 'queue', 'producer', 'consumer', 'consumes',
  'produces', 'function', 'functions', 'method', 'methods', 'class',
  'classes', 'implement', 'implemented', 'defined', 'calculate',
  'compute', 'owns', 'owners', 'team', 'teams', 'maintainer',
  'history', 'first', 'added', 'introduced', 'happens', 'flow', 'journey',
  'user', 'end', 'this', 'that', 'have', 'has', 'be',
]);

export interface CypherTemplate {
  readonly key: CypherTemplateKey;
  readonly cypher: string;
  readonly description: string;
}

const TEMPLATES: Readonly<Record<CypherTemplateKey, CypherTemplate>> = Object.freeze({
  topology: {
    key: 'topology',
    description: 'Upstream + downstream services within depth 3 from a service name.',
    cypher: `
      MATCH (s:Service)
      WHERE toLower(s.name) IN $serviceNames
      OPTIONAL MATCH path_out = (s)-[:DEPENDS_ON|USES|CALLS*1..3]->(down:Service)
      OPTIONAL MATCH path_in  = (up:Service)-[:DEPENDS_ON|USES|CALLS*1..3]->(s)
      WITH s, collect(DISTINCT down) AS downstream, collect(DISTINCT up) AS upstream
      RETURN s.name AS service,
             [d IN downstream WHERE d IS NOT NULL | d.name] AS downstream,
             [u IN upstream   WHERE u IS NOT NULL | u.name] AS upstream
      LIMIT 25
    `.trim(),
  },
  ownership: {
    key: 'ownership',
    description: 'Service → owner / team via OWNS / MAINTAINS edges.',
    cypher: `
      MATCH (s:Service)
      WHERE toLower(s.name) IN $serviceNames
      OPTIONAL MATCH (s)<-[:OWNS|MAINTAINS]-(o)
      RETURN s.name AS service,
             collect(DISTINCT { id: coalesce(o.id, ''), name: coalesce(o.name, ''), labels: labels(o) }) AS owners
      LIMIT 25
    `.trim(),
  },
  config: {
    key: 'config',
    description: 'Service → ConfigKey list.',
    cypher: `
      MATCH (s:Service)
      WHERE toLower(s.name) IN $serviceNames
      OPTIONAL MATCH (s)-[:READS_CONFIG]->(c)
      RETURN s.name AS service,
             collect(DISTINCT { id: coalesce(c.id, ''), name: coalesce(c.name, ''), source: coalesce(c.source, '') }) AS configs
      LIMIT 25
    `.trim(),
  },
  kafka: {
    key: 'kafka',
    description: 'Service → MessageQueue / Topic, both PRODUCES and CONSUMES.',
    cypher: `
      MATCH (s:Service)
      WHERE toLower(s.name) IN $serviceNames
      OPTIONAL MATCH (s)-[:PRODUCES]->(p:MessageQueue)
      OPTIONAL MATCH (s)-[:CONSUMES]->(c:MessageQueue)
      RETURN s.name AS service,
             collect(DISTINCT p.name) AS produces,
             collect(DISTINCT c.name) AS consumes
      LIMIT 25
    `.trim(),
  },
  commits: {
    // History/Commit nodes don't exist yet (Phase 1.7). Return empty so the
    // executor still produces a structured response.
    key: 'commits',
    description: 'Placeholder — Commit nodes not in graph yet (Phase 1.7).',
    cypher: `
      RETURN [] AS commits LIMIT 1
    `.trim(),
  },
});

export function getTemplate(key: CypherTemplateKey): CypherTemplate {
  return TEMPLATES[key];
}

export function listTemplates(): Readonly<Record<CypherTemplateKey, CypherTemplate>> {
  return TEMPLATES;
}

/**
 * Extract candidate service names from a question. Naive: lowercased,
 * deduped, stopword-filtered. Empty result is a valid output.
 */
export function extractServiceNames(question: string): readonly string[] {
  const out = new Set<string>();
  const lower = question.toLowerCase();
  const matches = lower.matchAll(SERVICE_NAME_RE);
  for (const m of matches) {
    const tok = m[1];
    if (!tok) continue;
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    // Require either a hyphen or a known suffix to avoid pure-noise nouns.
    if (!tok.includes('-') && !/(service|api|gql|cli|ui)$/.test(tok)) continue;
    out.add(tok);
  }
  return [...out];
}
