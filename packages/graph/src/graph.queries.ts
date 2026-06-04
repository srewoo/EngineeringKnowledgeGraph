/**
 * Named Cypher query templates for common graph operations.
 *
 * These are the deterministic graph queries (Layer 1 of the query engine).
 * Each function returns structured data, not raw Neo4j records.
 */

import { createLogger, LOCAL_REQUEST_CONTEXT } from '@ekg/shared';
import type { Logger, RequestContext } from '@ekg/shared';
import { Neo4jClient } from './neo4j.client.js';

interface QueryResult {
  readonly name: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
}

interface DependencyResult {
  readonly service: string;
  readonly dependsOn: string;
  readonly relationshipType: string;
  readonly confidence: string;
  readonly depth: number;
}

interface ImpactResult {
  readonly affectedNode: string;
  readonly affectedLabel: string;
  readonly path: string[];
  readonly depth: number;
}

/** Hard cap to keep history queries cheap and bounded — see PERFORMANCE BUDGET in CLAUDE.md. */
const MAX_HISTORY_LIMIT = 100;
function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), MAX_HISTORY_LIMIT);
}

/** Drop the `embedding` array from properties before returning — keeps responses small. */
function stripVector(props: Record<string, unknown>): Record<string, unknown> {
  if (!props || typeof props !== 'object') return props;
  if (!('embedding' in props)) return props;
  const { embedding: _omit, ...rest } = props;
  return rest;
}

/** Pure cosine norm — exported only conceptually. Inlined for the fallback Cypher path. */
function vectorNorm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export class GraphQueries {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'graph-queries' });
  }

  /**
   * Search for nodes matching a query string. Supports a single label
   * or a list of labels (multi-label OR). Returns results ranked by:
   *   1. Exact name match
   *   2. Name starts with query
   *   3. Name contains query
   *   4. Id contains query
   */
  async searchNodes(
    query: string,
    label?: string | readonly string[],
    limit = 20,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const labels = Array.isArray(label)
        ? label as readonly string[]
        : (typeof label === 'string' && label ? [label] : []);

      const labelFilter = labels.length > 0
        ? `WHERE (${labels.map((l) => `n:${l}`).join(' OR ')}) AND `
        : 'WHERE ';

      // Phase 2 multi-tenant: AND in the tenantId filter.
      const result = await session.run(
        `MATCH (n)
         ${labelFilter}coalesce(n.tenantId, 'local') = $tenantId
                      AND (toLower(n.name) CONTAINS toLower($query)
                           OR toLower(n.id) CONTAINS toLower($query))
         WITH n,
              CASE
                WHEN toLower(n.name) = toLower($query) THEN 4
                WHEN toLower(n.name) STARTS WITH toLower($query) THEN 3
                WHEN toLower(n.name) CONTAINS toLower($query) THEN 2
                ELSE 1
              END AS score
         RETURN n.name AS name, labels(n)[0] AS label, properties(n) AS properties, score
         ORDER BY score DESC, n.name ASC
         LIMIT $limit`,
        { query, limit, tenantId: ctx.tenantId },
      );

      return result.records.map((record) => ({
        name: record.get('name') as string,
        label: record.get('label') as string,
        properties: record.get('properties') as Record<string, unknown>,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get all services in the graph.
   */
  async listServices(ctx: RequestContext = LOCAL_REQUEST_CONTEXT): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      // Phase 2 multi-tenant: filter by tenantId. Rows lacking the
      // property predate the multi-tenant migration; we treat them as
      // 'local' so old graphs keep working unchanged.
      const result = await session.run(
        `MATCH (s:Service)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
         RETURN s.name AS name, 'Service' AS label, properties(s) AS properties
         ORDER BY s.name`,
        { tenantId: ctx.tenantId },
      );

      return result.records.map((record) => ({
        name: record.get('name') as string,
        label: record.get('label') as string,
        properties: record.get('properties') as Record<string, unknown>,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get all databases in the graph.
   */
  async listDatabases(ctx: RequestContext = LOCAL_REQUEST_CONTEXT): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (d:Database)
         WHERE coalesce(d.tenantId, 'local') = $tenantId
         RETURN d.name AS name, 'Database' AS label, properties(d) AS properties
         ORDER BY d.name`,
        { tenantId: ctx.tenantId },
      );

      return result.records.map((record) => ({
        name: record.get('name') as string,
        label: record.get('label') as string,
        properties: record.get('properties') as Record<string, unknown>,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get direct and transitive dependencies of a service.
   * Uses variable-length path matching up to the specified depth.
   */
  async getDependencies(
    serviceName: string,
    depth = 2,
    options?: { excludeLabels?: readonly string[]; excludeNpm?: boolean },
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly DependencyResult[]> {
    const session = this.client.getReadSession();
    try {
      const exclude = new Set([
        ...(options?.excludeLabels ?? []),
      ]);
      const labelFilter = exclude.size > 0
        ? `AND NONE(n IN nodes(path) WHERE ${[...exclude].map((l) => `n:${l}`).join(' OR ')})`
        : '';
      const npmFilter = options?.excludeNpm
        ? `AND NONE(n IN nodes(path) WHERE n:Module AND n.id STARTS WITH 'npm:')`
        : '';

      // Phase 2 multi-tenant: scope both the seed Service and every node
      // along the traversal path by tenantId. `coalesce(...,'local')` lets
      // pre-tenant rows still resolve under the local tenant.
      const result = await session.run(
        `MATCH path = (s:Service {name: $serviceName})-[r*1..${Math.min(depth, 10)}]->(target)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND ALL(n IN nodes(path) WHERE coalesce(n.tenantId, 'local') = $tenantId)
           ${labelFilter} ${npmFilter}
         UNWIND relationships(path) AS rel
         RETURN s.name AS service,
                target.name AS dependsOn,
                labels(target)[0] AS targetLabel,
                type(rel) AS relationshipType,
                COALESCE(rel.confidence, 'HIGH') AS confidence,
                length(path) AS depth
         ORDER BY depth, target.name`,
        { serviceName, tenantId: ctx.tenantId },
      );

      return result.records.map((record) => ({
        service: record.get('service') as string,
        dependsOn: record.get('dependsOn') as string,
        relationshipType: record.get('relationshipType') as string,
        confidence: record.get('confidence') as string,
        depth: (record.get('depth') as { toNumber(): number }).toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Impact analysis — find all nodes affected if a given node changes.
   * Traverses incoming relationships to find upstream dependents.
   */
  async analyzeImpact(
    nodeName: string,
    depth = 3,
    options?: { excludeLabels?: readonly string[]; excludeNpm?: boolean; onlyServices?: boolean },
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly ImpactResult[]> {
    const session = this.client.getReadSession();
    try {
      const exclude = new Set([
        ...(options?.excludeLabels ?? []),
      ]);
      const labelFilter = exclude.size > 0
        ? `AND NONE(n IN nodes(path) WHERE ${[...exclude].map((l) => `n:${l}`).join(' OR ')})`
        : '';
      const npmFilter = options?.excludeNpm
        ? `AND NONE(n IN nodes(path) WHERE n:Module AND n.id STARTS WITH 'npm:')`
        : '';
      const serviceFilter = options?.onlyServices ? 'AND affected:Service' : '';

      // Phase 2: scope target + every node on the path.
      const result = await session.run(
        `MATCH path = (affected)-[*1..${Math.min(depth, 10)}]->(target {name: $nodeName})
         WHERE coalesce(target.tenantId, 'local') = $tenantId
           AND ALL(n IN nodes(path) WHERE coalesce(n.tenantId, 'local') = $tenantId)
           ${labelFilter} ${npmFilter} ${serviceFilter}
         RETURN affected.name AS affectedNode,
                labels(affected)[0] AS affectedLabel,
                [node IN nodes(path) | node.name] AS path,
                length(path) AS depth
         ORDER BY depth, affected.name`,
        { nodeName, tenantId: ctx.tenantId },
      );

      return result.records.map((record) => ({
        affectedNode: record.get('affectedNode') as string,
        affectedLabel: record.get('affectedLabel') as string,
        path: record.get('path') as string[],
        depth: (record.get('depth') as { toNumber(): number }).toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get a summary of a service — its APIs, databases, and dependencies.
   */
  async getServiceSummary(
    serviceName: string,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<{
    readonly service: QueryResult | null;
    readonly apis: readonly QueryResult[];
    readonly databases: readonly QueryResult[];
    readonly dependencies: readonly QueryResult[];
    readonly dependents: readonly QueryResult[];
    /** Phase C v2: auto-attached runtime evidence from OBSERVED_CALL edges. */
    readonly runtime: Readonly<{
      observedOut: readonly Record<string, unknown>[];
      observedIn: readonly Record<string, unknown>[];
      hasRuntimeData: boolean;
    }>;
  }> {
    const session = this.client.getReadSession();
    const tenantId = ctx.tenantId;
    try {
      // Service node — tenant-scoped.
      const serviceResult = await session.run(
        `MATCH (s:Service {name: $name})
         WHERE coalesce(s.tenantId, 'local') = $tenantId
         RETURN s.name AS name, 'Service' AS label, properties(s) AS properties`,
        { name: serviceName, tenantId },
      );
      const service = serviceResult.records.length > 0
        ? {
            name: serviceResult.records[0]!.get('name') as string,
            label: serviceResult.records[0]!.get('label') as string,
            properties: serviceResult.records[0]!.get('properties') as Record<string, unknown>,
          }
        : null;

      // APIs exposed — tenant-scoped at both ends to prevent cross-tenant leakage.
      const apiResult = await session.run(
        `MATCH (s:Service {name: $name})-[:EXPOSES]->(a:API)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(a.tenantId, 'local') = $tenantId
         RETURN a.name AS name, 'API' AS label, properties(a) AS properties`,
        { name: serviceName, tenantId },
      );
      const apis = apiResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Databases used — tenant-scoped both ends.
      const dbResult = await session.run(
        `MATCH (s:Service {name: $name})-[:USES]->(d:Database)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(d.tenantId, 'local') = $tenantId
         RETURN d.name AS name, 'Database' AS label, properties(d) AS properties`,
        { name: serviceName, tenantId },
      );
      const databases = dbResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Outgoing dependencies — tenant-scoped at both ends.
      const depResult = await session.run(
        `MATCH (s:Service {name: $name})-[:CALLS|DEPENDS_ON]->(t)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(t.tenantId, 'local') = $tenantId
         RETURN t.name AS name, labels(t)[0] AS label, properties(t) AS properties`,
        { name: serviceName, tenantId },
      );
      const dependencies = depResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Incoming dependents — tenant-scoped both ends.
      const dependentResult = await session.run(
        `MATCH (t)-[:CALLS|DEPENDS_ON]->(s:Service {name: $name})
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(t.tenantId, 'local') = $tenantId
         RETURN t.name AS name, labels(t)[0] AS label, properties(t) AS properties`,
        { name: serviceName, tenantId },
      );
      const dependents = dependentResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Phase C v2: auto-attach the latest observed runtime edges so APM
      // signal lands in get_service_summary without a separate tool call.
      // Skips silently if no OBSERVED_CALL edges exist for the service.
      // Phase 2 multi-tenant: scope every Service node.
      const runtimeResult = await session.run(
        `OPTIONAL MATCH (s:Service {name: $name})-[r_out:OBSERVED_CALL]->(callee:Service)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(callee.tenantId, 'local') = $tenantId
         WITH collect(DISTINCT {
           callee: callee.name,
           callCount: r_out.callCount,
           errorCount: r_out.errorCount,
           p99LatencyMs: r_out.p99LatencyMs,
           lastSeenAt: r_out.lastSeenAt,
           source: r_out.source
         }) AS outgoing
         OPTIONAL MATCH (caller:Service)-[r_in:OBSERVED_CALL]->(target:Service {name: $name})
         WHERE coalesce(caller.tenantId, 'local') = $tenantId
           AND coalesce(target.tenantId, 'local') = $tenantId
         WITH outgoing, collect(DISTINCT {
           caller: caller.name,
           callCount: r_in.callCount,
           errorCount: r_in.errorCount,
           p99LatencyMs: r_in.p99LatencyMs,
           lastSeenAt: r_in.lastSeenAt,
           source: r_in.source
         }) AS incoming
         RETURN
           [x IN outgoing WHERE x.callee IS NOT NULL] AS observedOut,
           [x IN incoming WHERE x.caller IS NOT NULL] AS observedIn`,
        { name: serviceName, tenantId },
      );
      const runtimeRow = runtimeResult.records[0];
      const observedOut = runtimeRow ? (runtimeRow.get('observedOut') as readonly Record<string, unknown>[]) : [];
      const observedIn  = runtimeRow ? (runtimeRow.get('observedIn')  as readonly Record<string, unknown>[]) : [];

      return {
        service,
        apis,
        databases,
        dependencies,
        dependents,
        runtime: {
          observedOut,
          observedIn,
          hasRuntimeData: observedOut.length > 0 || observedIn.length > 0,
        },
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Phase B (history): list commits that touched a file path, most recent first.
   * Returns empty if git history ingestion was disabled at extraction time.
   */
  async fileHistory(
    filePath: string,
    limit = 20,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { sha: string; author: string; authorEmail: string; message: string; authoredAt: string; repoUrl: string }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (c:Commit)-[t:TOUCHED]->(f:File)
         WHERE (f.path = $filePath OR f.id ENDS WITH $filePath)
           AND coalesce(c.tenantId, 'local') = $tenantId
           AND coalesce(f.tenantId, 'local') = $tenantId
         RETURN c.sha AS sha, c.author AS author, c.authorEmail AS authorEmail,
                c.message AS message, c.authoredAt AS authoredAt, c.repoUrl AS repoUrl
         ORDER BY c.authoredAt DESC
         LIMIT ${safeLimit}`,
        { filePath, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        sha: r.get('sha') as string,
        author: r.get('author') as string,
        authorEmail: r.get('authorEmail') as string,
        message: r.get('message') as string,
        authoredAt: r.get('authoredAt') as string,
        repoUrl: r.get('repoUrl') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase B (history): list authors who touched a file, ranked by commit count.
   * Useful for "who knows this code" / blame-like attribution.
   */
  async whoTouchedFile(
    filePath: string,
    limit = 10,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { author: string; authorEmail: string; commitCount: number; lastAuthoredAt: string }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (c:Commit)-[t:TOUCHED]->(f:File)
         WHERE (f.path = $filePath OR f.id ENDS WITH $filePath)
           AND coalesce(c.tenantId, 'local') = $tenantId
           AND coalesce(f.tenantId, 'local') = $tenantId
         RETURN c.author AS author, c.authorEmail AS authorEmail,
                count(c) AS commitCount,
                max(c.authoredAt) AS lastAuthoredAt
         ORDER BY commitCount DESC
         LIMIT ${safeLimit}`,
        { filePath, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        author: r.get('author') as string,
        authorEmail: r.get('authorEmail') as string,
        commitCount: (r.get('commitCount') as { toNumber: () => number }).toNumber(),
        lastAuthoredAt: r.get('lastAuthoredAt') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase B (history): recent activity in a service — commits touching any file
   * that belongs to the service (via CONTAINS). Lets agents answer
   * "what's been changing in X lately".
   */
  async serviceRecentCommits(
    serviceName: string,
    limit = 20,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { sha: string; author: string; message: string; authoredAt: string; filesTouched: number }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (s:Service {name: $serviceName})-[:CONTAINS*1..3]->(f:File)<-[:TOUCHED]-(c:Commit)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(f.tenantId, 'local') = $tenantId
           AND coalesce(c.tenantId, 'local') = $tenantId
         WITH c, count(DISTINCT f) AS filesTouched
         RETURN c.sha AS sha, c.author AS author, c.message AS message,
                c.authoredAt AS authoredAt, filesTouched
         ORDER BY c.authoredAt DESC
         LIMIT ${safeLimit}`,
        { serviceName, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        sha: r.get('sha') as string,
        author: r.get('author') as string,
        message: r.get('message') as string,
        authoredAt: r.get('authoredAt') as string,
        filesTouched: (r.get('filesTouched') as { toNumber: () => number }).toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase B (history): list MRs persisted into the graph for a given project
   * path, newest first. Useful for "what MRs touched service X recently".
   */
  async listMrs(
    projectPathOrAuthor: string,
    by: 'project' | 'author' = 'project',
    limit = 20,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { iid: number; title: string; state: string; author: string; webUrl: string; updatedAt: string; filesChanged: number; diffSize: number }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const cypher = by === 'project'
        ? `MATCH (mr:MR {projectPath: $needle})
           WHERE coalesce(mr.tenantId, 'local') = $tenantId
           RETURN mr.iid AS iid, mr.title AS title, mr.state AS state,
                  mr.author AS author, mr.webUrl AS webUrl,
                  mr.updatedAt AS updatedAt, mr.filesChanged AS filesChanged,
                  mr.diffSize AS diffSize
           ORDER BY mr.updatedAt DESC
           LIMIT ${safeLimit}`
        : `MATCH (mr:MR {author: $needle})
           WHERE coalesce(mr.tenantId, 'local') = $tenantId
           RETURN mr.iid AS iid, mr.title AS title, mr.state AS state,
                  mr.author AS author, mr.webUrl AS webUrl,
                  mr.updatedAt AS updatedAt, mr.filesChanged AS filesChanged,
                  mr.diffSize AS diffSize
           ORDER BY mr.updatedAt DESC
           LIMIT ${safeLimit}`;
      const result = await session.run(cypher, { needle: projectPathOrAuthor, tenantId: ctx.tenantId });
      return result.records.map((r) => ({
        iid: typeof r.get('iid') === 'object' ? (r.get('iid') as { toNumber: () => number }).toNumber() : (r.get('iid') as number),
        title: r.get('title') as string,
        state: r.get('state') as string,
        author: r.get('author') as string,
        webUrl: r.get('webUrl') as string,
        updatedAt: r.get('updatedAt') as string,
        filesChanged: typeof r.get('filesChanged') === 'object' ? (r.get('filesChanged') as { toNumber: () => number }).toNumber() : (r.get('filesChanged') as number) ?? 0,
        diffSize: typeof r.get('diffSize') === 'object' ? (r.get('diffSize') as { toNumber: () => number }).toNumber() : (r.get('diffSize') as number) ?? 0,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase G: which APIs expose a given column? Useful for impact analysis
   * before renaming or dropping a column. `target` matches either:
   *   - exact column name (case-insensitive), or
   *   - `<table>.<column>` qualifier (case-insensitive substring on column id).
   */
  async apisExposingColumn(
    target: string,
    limit = 25,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { apiId: string; method: string; path: string; service: string; column: string; matchKind: string; confidence: string }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (a:API)-[r:EXPOSES_DATA]->(c:Column)
         WHERE (toLower(c.name) = toLower($target) OR toLower(c.id) CONTAINS toLower($target))
           AND coalesce(a.tenantId, 'local') = $tenantId
           AND coalesce(c.tenantId, 'local') = $tenantId
         OPTIONAL MATCH (s:Service)-[:EXPOSES]->(a)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
         RETURN a.id AS apiId, a.method AS method, a.path AS path,
                coalesce(s.name, '') AS service,
                c.name AS column,
                coalesce(r.matchKind, 'exact') AS matchKind,
                r.confidence AS confidence
         ORDER BY confidence DESC, path
         LIMIT ${safeLimit}`,
        { target, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        apiId: r.get('apiId') as string,
        method: r.get('method') as string,
        path: r.get('path') as string,
        service: r.get('service') as string,
        column: r.get('column') as string,
        matchKind: r.get('matchKind') as string,
        confidence: r.get('confidence') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase E: list TestCase nodes that exercise a given file (matched by
   * path suffix or exact id). Returns most-recently-updated first.
   */
  async testsCoveringFile(
    filePath: string,
    limit = 20,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { id: string; name: string; testFile: string; framework: string; language: string }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (t:TestCase)-[:TESTS]->(f:File)
         WHERE (f.path = $filePath OR f.id ENDS WITH $filePath)
           AND coalesce(t.tenantId, 'local') = $tenantId
           AND coalesce(f.tenantId, 'local') = $tenantId
         RETURN t.id AS id, t.name AS name,
                t.testFile AS testFile, t.framework AS framework,
                t.language AS language
         ORDER BY t.testFile
         LIMIT ${safeLimit}`,
        { filePath, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        testFile: r.get('testFile') as string,
        framework: r.get('framework') as string,
        language: r.get('language') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase E: list File nodes in a service that have NO incoming TESTS edge.
   * Useful for "what's untested in service X". Bounded — caller pages with `limit`.
   */
  async untestedFilesInService(
    serviceName: string,
    limit = 50,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { id: string; path: string }[]> {
    const safeLimit = clampLimit(limit);
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (s:Service {name: $serviceName})-[:CONTAINS*1..3]->(f:File)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
           AND coalesce(f.tenantId, 'local') = $tenantId
           AND NOT (f)<-[:TESTS]-(:TestCase)
           AND NOT f.path CONTAINS '.test.'
           AND NOT f.path CONTAINS '_test.'
           AND NOT f.path STARTS WITH 'test/'
         RETURN DISTINCT f.id AS id, f.path AS path
         ORDER BY f.path
         LIMIT ${safeLimit}`,
        { serviceName, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => ({
        id: r.get('id') as string,
        path: r.get('path') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Phase D: native vector search over a label's `embedding` property.
   * Uses Neo4j 5's vector index (`db.index.vector.queryNodes`). Falls back
   * to brute-force cosine in Cypher when the index is missing — slow but
   * correct.
   *
   * Returns up to `limit` nodes ordered by similarity desc.
   */
  async searchNodesByVector(
    label: string,
    queryVector: readonly number[],
    limit = 10,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly { id: string; name: string; score: number; properties: Record<string, unknown> }[]> {
    const safeLimit = clampLimit(limit);
    const indexName = `${label.toLowerCase()}_embedding_vec`;
    const session = this.client.getReadSession();
    try {
      // Try the native vector index first. The index itself doesn't know
      // about tenancy; we post-filter on the returned nodes' tenantId.
      const native = await session.run(
        `CALL db.index.vector.queryNodes($indexName, $k, $vec) YIELD node, score
         WHERE coalesce(node.tenantId, 'local') = $tenantId
         RETURN node.id AS id, node.name AS name, score, properties(node) AS properties
         ORDER BY score DESC`,
        { indexName, k: safeLimit, vec: queryVector, tenantId: ctx.tenantId },
      ).catch(() => undefined);
      if (native && native.records.length > 0) {
        return native.records.map((r) => ({
          id: r.get('id') as string,
          name: r.get('name') as string,
          score: r.get('score') as number,
          properties: stripVector(r.get('properties') as Record<string, unknown>),
        }));
      }
      // Fallback: brute-force cosine. Bounded by label + presence of vector + tenant.
      const fallback = await session.run(
        `MATCH (n:${label})
         WHERE n.embedding IS NOT NULL AND n.embeddingDim = $dim
           AND coalesce(n.tenantId, 'local') = $tenantId
         WITH n,
              reduce(s = 0.0, i IN range(0, size(n.embedding)-1) | s + n.embedding[i] * $vec[i]) AS dot,
              sqrt(reduce(s = 0.0, x IN n.embedding | s + x*x)) AS nnorm
         WITH n, CASE WHEN nnorm = 0 THEN 0.0 ELSE dot / (nnorm * $qnorm) END AS score
         RETURN n.id AS id, n.name AS name, score, properties(n) AS properties
         ORDER BY score DESC
         LIMIT ${safeLimit}`,
        { vec: queryVector, dim: queryVector.length, qnorm: vectorNorm(queryVector) || 1, tenantId: ctx.tenantId },
      );
      return fallback.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        score: r.get('score') as number,
        properties: stripVector(r.get('properties') as Record<string, unknown>),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Item 3 — cross-service HTTP resolution: count resolved CALLS_API edges,
   * broken down by confidence band (HIGH = exact host+path, MEDIUM = fuzzy /
   * template, LOW = path-only). The *unresolved* side lives in SQLite
   * (`UnresolvedHttpRepository`); the caller combines both to compute a
   * first-class resolution rate.
   */
  async httpResolutionStats(
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<{ readonly resolved: number; readonly byConfidence: Record<string, number> }> {
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH ()-[r:CALLS_API]->(:API)
         WHERE coalesce(r.tenantId, 'local') = $tenantId
            OR r.tenantId IS NULL
         RETURN COALESCE(r.confidence, 'HIGH') AS confidence, count(r) AS n`,
        { tenantId: ctx.tenantId },
      );
      const byConfidence: Record<string, number> = {};
      let resolved = 0;
      for (const rec of result.records) {
        const c = rec.get('confidence') as string;
        const n = (rec.get('n') as { toNumber: () => number }).toNumber();
        byConfidence[c] = (byConfidence[c] ?? 0) + n;
        resolved += n;
      }
      return { resolved, byConfidence };
    } finally {
      await session.close();
    }
  }

  /**
   * Item 4 — provenance / per-extractor coverage. For each Service, report
   * whether it has at least one neighbour of each major extracted kind
   * (API / Database / Table / Owner / Topic / Doc). Aggregates into "fraction
   * of services with X" so we can say what we're *missing*, not just what we
   * have. Also counts Tables lacking provenance (no source file + no Migration
   * link) — the §8 "flag tables with no provenance" requirement.
   */
  async provenanceCoverage(
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<{
    readonly totalServices: number;
    readonly withApi: number;
    readonly withDatabase: number;
    readonly withTable: number;
    readonly withOwner: number;
    readonly withTopic: number;
    readonly withDoc: number;
    readonly servicesMissingAll: readonly string[];
    readonly tablesTotal: number;
    readonly tablesWithoutProvenance: number;
    readonly nodeCountsByLabel: Record<string, number>;
  }> {
    const session = this.client.getReadSession();
    const tenantId = ctx.tenantId;
    try {
      const svc = await session.run(
        `MATCH (s:Service)
         WHERE coalesce(s.tenantId, 'local') = $tenantId
         RETURN
           count(s) AS total,
           sum(CASE WHEN (s)-[:EXPOSES]->(:API) THEN 1 ELSE 0 END) AS withApi,
           sum(CASE WHEN (s)-[:USES]->(:Database) THEN 1 ELSE 0 END) AS withDatabase,
           sum(CASE WHEN (s)-[:OWNS|HAS]->(:Table) OR (s)-[:CONTAINS*1..3]->(:Table) THEN 1 ELSE 0 END) AS withTable,
           sum(CASE WHEN (s)<-[:OWNS]-(:Owner) OR (s)-[:OWNED_BY]->(:Owner) OR (s)-[:CONTAINS*1..3]->(:File)-[:OWNED_BY]->(:Owner) THEN 1 ELSE 0 END) AS withOwner,
           sum(CASE WHEN (s)-[:PRODUCES|CONSUMES]->(:Topic) THEN 1 ELSE 0 END) AS withTopic,
           sum(CASE WHEN (s)-[:DOCUMENTED_BY]->(:Doc) THEN 1 ELSE 0 END) AS withDoc,
           collect(CASE WHEN NOT (
             (s)-[:EXPOSES]->(:API) OR (s)-[:USES]->(:Database)
             OR (s)-[:PRODUCES|CONSUMES]->(:Topic) OR (s)-[:DOCUMENTED_BY]->(:Doc)
           ) THEN s.name ELSE null END) AS missingAll`,
        { tenantId },
      );
      const row = svc.records[0];
      const num = (k: string): number => {
        if (!row) return 0;
        const v = row.get(k) as { toNumber?: () => number } | number | null;
        if (v && typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      const tables = await session.run(
        `MATCH (t:Table)
         WHERE coalesce(t.tenantId, 'local') = $tenantId
         RETURN count(t) AS total,
                sum(CASE WHEN (coalesce(t.filePath, '') = '' AND NOT (t)<-[:ALTERS]-(:Migration)) THEN 1 ELSE 0 END) AS noProvenance`,
        { tenantId },
      );
      const trow = tables.records[0];
      const tablesTotal = trow ? (trow.get('total') as { toNumber: () => number }).toNumber() : 0;
      const tablesWithoutProvenance = trow ? (trow.get('noProvenance') as { toNumber: () => number }).toNumber() : 0;

      const labelCounts = await session.run(
        `MATCH (n)
         WHERE coalesce(n.tenantId, 'local') = $tenantId
         RETURN labels(n)[0] AS label, count(n) AS n
         ORDER BY n DESC`,
        { tenantId },
      );
      const nodeCountsByLabel: Record<string, number> = {};
      for (const rec of labelCounts.records) {
        const label = rec.get('label') as string | null;
        if (!label) continue;
        nodeCountsByLabel[label] = (rec.get('n') as { toNumber: () => number }).toNumber();
      }

      const missingAll = row
        ? ((row.get('missingAll') as (string | null)[]).filter((x): x is string => typeof x === 'string'))
        : [];

      return {
        totalServices: num('total'),
        withApi: num('withApi'),
        withDatabase: num('withDatabase'),
        withTable: num('withTable'),
        withOwner: num('withOwner'),
        withTopic: num('withTopic'),
        withDoc: num('withDoc'),
        servicesMissingAll: missingAll,
        tablesTotal,
        tablesWithoutProvenance,
        nodeCountsByLabel,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Item 5 — confidence calibration: sample edges in a given confidence band
   * with enough provenance (endpoint names/labels, source file/line, reason)
   * for a human or a re-derivation pass to judge whether the edge is actually
   * correct. `ORDER BY rand()` gives an unbiased sample; bounded by `limit`.
   */
  async sampleEdgesByConfidence(
    confidence: 'HIGH' | 'MEDIUM' | 'LOW',
    limit = 25,
    relType?: string,
    ctx: RequestContext = LOCAL_REQUEST_CONTEXT,
  ): Promise<readonly {
    edgeKey: string;
    type: string;
    confidence: string;
    sourceId: string; sourceName: string; sourceLabel: string;
    targetId: string; targetName: string; targetLabel: string;
    sourceFile: string | null; sourceLine: number | null; reason: string | null;
  }[]> {
    const safeLimit = clampLimit(limit);
    const relFilter = relType && /^[A-Z_]+$/.test(relType) ? `:${relType}` : '';
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (a)-[r${relFilter}]->(b)
         WHERE COALESCE(r.confidence, 'HIGH') = $confidence
           AND coalesce(a.tenantId, 'local') = $tenantId
           AND coalesce(b.tenantId, 'local') = $tenantId
         RETURN type(r) AS type, COALESCE(r.confidence, 'HIGH') AS confidence,
                a.id AS sourceId, a.name AS sourceName, labels(a)[0] AS sourceLabel,
                b.id AS targetId, b.name AS targetName, labels(b)[0] AS targetLabel,
                coalesce(r.sourceFile, a.path, a.filePath) AS sourceFile,
                coalesce(r.sourceLine, a.sourceLine) AS sourceLine,
                r.reason AS reason
         ORDER BY rand()
         LIMIT ${safeLimit}`,
        { confidence, tenantId: ctx.tenantId },
      );
      return result.records.map((r) => {
        const sourceId = r.get('sourceId') as string;
        const targetId = r.get('targetId') as string;
        const type = r.get('type') as string;
        const lineRaw = r.get('sourceLine') as { toNumber: () => number } | number | null;
        const sourceLine = lineRaw == null ? null : (typeof lineRaw === 'object' ? lineRaw.toNumber() : lineRaw);
        return {
          edgeKey: `${sourceId}|${type}|${targetId}`,
          type,
          confidence: r.get('confidence') as string,
          sourceId,
          sourceName: (r.get('sourceName') as string) ?? sourceId,
          sourceLabel: (r.get('sourceLabel') as string) ?? '',
          targetId,
          targetName: (r.get('targetName') as string) ?? targetId,
          targetLabel: (r.get('targetLabel') as string) ?? '',
          sourceFile: (r.get('sourceFile') as string | null) ?? null,
          sourceLine,
          reason: (r.get('reason') as string | null) ?? null,
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * List all API endpoints, optionally filtered by service.
   */
  async getApiMap(serviceName?: string, ctx: RequestContext = LOCAL_REQUEST_CONTEXT): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const query = serviceName
        ? `MATCH (s:Service {name: $serviceName})-[:EXPOSES]->(a:API)
           WHERE coalesce(s.tenantId, 'local') = $tenantId
             AND coalesce(a.tenantId, 'local') = $tenantId
           RETURN a.name AS name, 'API' AS label, properties(a) AS properties
           ORDER BY a.path`
        : `MATCH (a:API)
           WHERE coalesce(a.tenantId, 'local') = $tenantId
           RETURN a.name AS name, 'API' AS label, properties(a) AS properties
           ORDER BY a.path`;

      const result = await session.run(query, { serviceName: serviceName ?? '', tenantId: ctx.tenantId });

      return result.records.map((record) => ({
        name: record.get('name') as string,
        label: record.get('label') as string,
        properties: record.get('properties') as Record<string, unknown>,
      }));
    } finally {
      await session.close();
    }
  }
}
