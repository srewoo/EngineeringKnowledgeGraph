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
    // Phase 1.6 — return ConfigKey nodes (and any USES_SECRET edges) for a
    // resolved service OR for any key whose name CONTAINS the `$entity`
    // substring. Capped at 30 rows to keep traversal bounded.
    key: 'config',
    description: 'ConfigKey + SecretRef nodes for a service, or by key-name substring.',
    cypher: `
      OPTIONAL MATCH (svc:Service)
        WHERE toLower(svc.name) IN $serviceNames
      OPTIONAL MATCH (svc)-[:READS_CONFIG]->(svcKey:ConfigKey)
      OPTIONAL MATCH (svc)-[:USES_SECRET]->(svcSecret:SecretRef)
      WITH svc,
           collect(DISTINCT svcKey) AS svcKeys,
           collect(DISTINCT svcSecret) AS svcSecrets
      OPTIONAL MATCH (k:ConfigKey)
        WHERE $entity <> ''
          AND (toLower(k.key) CONTAINS toLower($entity)
               OR toLower(coalesce(k.name, '')) CONTAINS toLower($entity))
      WITH svc, svcKeys, svcSecrets,
           collect(DISTINCT k) AS keyMatches
      WITH svc, svcKeys + keyMatches AS allKeys, svcSecrets
      UNWIND (CASE WHEN size(allKeys) = 0 THEN [null] ELSE allKeys END) AS ck
      WITH svc, ck, svcSecrets, allKeys
      RETURN coalesce(svc.name, '') AS service,
             [k IN allKeys WHERE k IS NOT NULL |
               { id: k.id,
                 key: k.key,
                 kind: k.kind,
                 envScope: coalesce(k.envScope, ''),
                 defaultValue: coalesce(k.defaultValue, ''),
                 isSecret: coalesce(k.isSecret, false),
                 filePath: k.filePath }] AS configKeys,
             [s IN svcSecrets WHERE s IS NOT NULL |
               { id: s.id, vendor: s.vendor, ref: s.ref, filePath: s.filePath }] AS secretRefs
      LIMIT 30
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
  runtime: {
    // Phase C — OBSERVED_CALL edges materialised by RuntimeEdgesPass.
    // Returns inbound + outbound observed callers for a service, plus the
    // most recently-seen call window.
    key: 'runtime',
    description: 'Observed service-to-service calls from runtime adapters (Datadog APM, etc).',
    cypher: `
      MATCH (s:Service)
      WHERE toLower(s.name) IN $serviceNames
      OPTIONAL MATCH (s)-[r_out:OBSERVED_CALL]->(callee:Service)
      OPTIONAL MATCH (caller:Service)-[r_in:OBSERVED_CALL]->(s)
      RETURN s.name AS service,
             collect(DISTINCT {
               callee: callee.name,
               source: r_out.source,
               lastSeenAt: r_out.lastSeenAt,
               callCount: r_out.callCount,
               errorCount: r_out.errorCount
             }) AS observedOut,
             collect(DISTINCT {
               caller: caller.name,
               source: r_in.source,
               lastSeenAt: r_in.lastSeenAt,
               callCount: r_in.callCount,
               errorCount: r_in.errorCount
             }) AS observedIn
      LIMIT 25
    `.trim(),
  },
  coverage: {
    // Phase E — TestCase / TESTS edges. Resolves an entity (file path
    // substring or service name) to either:
    //   - tests covering it, or
    //   - files inside it with no TESTS coverage
    key: 'coverage',
    description: 'Test coverage: which TestCase nodes cover which files inside a service.',
    cypher: `
      OPTIONAL MATCH (svc:Service)
        WHERE toLower(svc.name) IN $serviceNames
      OPTIONAL MATCH (svc)-[:CONTAINS*1..3]->(svcFile:File)
      WITH svc, collect(DISTINCT svcFile) AS svcFiles
      OPTIONAL MATCH (f:File)
        WHERE $entity <> '' AND toLower(f.path) CONTAINS toLower($entity)
      WITH svc, svcFiles + collect(DISTINCT f) AS allFiles
      UNWIND allFiles AS target
      WITH DISTINCT target WHERE target IS NOT NULL
      OPTIONAL MATCH (t:TestCase)-[:TESTS]->(target)
      WITH target, collect(DISTINCT { id: t.id, testFile: t.testFile, framework: t.framework }) AS tests
      RETURN target.path AS file,
             [x IN tests WHERE x.id IS NOT NULL] AS tests
      ORDER BY size(tests) ASC, file
      LIMIT 50
    `.trim(),
  },
  mrs: {
    // Phase B — MR nodes persisted via gitlab_get_mr persist=true.
    // Resolves to all MRs for a given projectPath (the gitlab namespace/project).
    key: 'mrs',
    description: 'Merge requests persisted in the graph for a project or author.',
    cypher: `
      MATCH (mr:MR)
      WHERE ($entity <> '' AND (toLower(mr.projectPath) CONTAINS toLower($entity)
                                OR toLower(mr.author) = toLower($entity)
                                OR toLower(mr.title)  CONTAINS toLower($entity)))
         OR (size($serviceNames) > 0 AND toLower(mr.projectPath) IN $serviceNames)
      OPTIONAL MATCH (o:Owner)-[:AUTHORED_MR]->(mr)
      RETURN mr.iid AS iid,
             mr.projectPath AS projectPath,
             mr.title AS title,
             mr.state AS state,
             mr.author AS author,
             mr.webUrl AS webUrl,
             mr.updatedAt AS updatedAt,
             mr.filesChanged AS filesChanged,
             mr.diffSize AS diffSize,
             o.identifier AS authorOwner
      ORDER BY mr.updatedAt DESC
      LIMIT 25
    `.trim(),
  },
  commits: {
    // Phase 1.7 — `Commit -[TOUCHED]-> File` edges populated when
    // EKG_GIT_HISTORY_ENABLED=true. Resolves an entity (file path or service
    // name) to recent commits. If $entity matches a service, expand to the
    // files it CONTAINS; otherwise treat $entity as a file-path substring.
    key: 'commits',
    description: 'Recent commits TOUCHing a file or any file under a service.',
    cypher: `
      OPTIONAL MATCH (svc:Service)
        WHERE toLower(svc.name) IN $serviceNames
      OPTIONAL MATCH (svc)-[:CONTAINS]->(svcFile:File)
      WITH collect(DISTINCT svcFile) AS svcFiles
      OPTIONAL MATCH (f:File)
        WHERE $entity <> '' AND toLower(f.path) CONTAINS toLower($entity)
      WITH svcFiles + collect(DISTINCT f) AS allFiles
      UNWIND allFiles AS target
      WITH DISTINCT target WHERE target IS NOT NULL
      MATCH (c:Commit)-[:TOUCHED]->(target)
      WITH c, collect(DISTINCT target.path) AS files
      RETURN c.sha AS sha,
             c.author AS author,
             c.authorEmail AS authorEmail,
             c.authoredAt AS authoredAt,
             c.message AS message,
             files
      ORDER BY c.authoredAt DESC
      LIMIT 20
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
