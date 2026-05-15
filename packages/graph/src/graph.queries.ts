/**
 * Named Cypher query templates for common graph operations.
 *
 * These are the deterministic graph queries (Layer 1 of the query engine).
 * Each function returns structured data, not raw Neo4j records.
 */

import type { Session } from 'neo4j-driver';
import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';
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
  ): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const labels = Array.isArray(label)
        ? label as readonly string[]
        : (typeof label === 'string' && label ? [label] : []);

      const labelFilter = labels.length > 0
        ? `WHERE (${labels.map((l) => `n:${l}`).join(' OR ')}) AND `
        : 'WHERE ';

      const result = await session.run(
        `MATCH (n)
         ${labelFilter}(toLower(n.name) CONTAINS toLower($query)
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
        { query, limit },
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
  async listServices(): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (s:Service)
         RETURN s.name AS name, 'Service' AS label, properties(s) AS properties
         ORDER BY s.name`,
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
  async listDatabases(): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const result = await session.run(
        `MATCH (d:Database)
         RETURN d.name AS name, 'Database' AS label, properties(d) AS properties
         ORDER BY d.name`,
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

      const result = await session.run(
        `MATCH path = (s:Service {name: $serviceName})-[r*1..${Math.min(depth, 10)}]->(target)
         WHERE 1=1 ${labelFilter} ${npmFilter}
         UNWIND relationships(path) AS rel
         RETURN s.name AS service,
                target.name AS dependsOn,
                labels(target)[0] AS targetLabel,
                type(rel) AS relationshipType,
                COALESCE(rel.confidence, 'HIGH') AS confidence,
                length(path) AS depth
         ORDER BY depth, target.name`,
        { serviceName },
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

      const result = await session.run(
        `MATCH path = (affected)-[*1..${Math.min(depth, 10)}]->(target {name: $nodeName})
         WHERE 1=1 ${labelFilter} ${npmFilter} ${serviceFilter}
         RETURN affected.name AS affectedNode,
                labels(affected)[0] AS affectedLabel,
                [node IN nodes(path) | node.name] AS path,
                length(path) AS depth
         ORDER BY depth, affected.name`,
        { nodeName },
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
  async getServiceSummary(serviceName: string): Promise<{
    readonly service: QueryResult | null;
    readonly apis: readonly QueryResult[];
    readonly databases: readonly QueryResult[];
    readonly dependencies: readonly QueryResult[];
    readonly dependents: readonly QueryResult[];
  }> {
    const session = this.client.getReadSession();
    try {
      // Service node
      const serviceResult = await session.run(
        `MATCH (s:Service {name: $name})
         RETURN s.name AS name, 'Service' AS label, properties(s) AS properties`,
        { name: serviceName },
      );
      const service = serviceResult.records.length > 0
        ? {
            name: serviceResult.records[0]!.get('name') as string,
            label: serviceResult.records[0]!.get('label') as string,
            properties: serviceResult.records[0]!.get('properties') as Record<string, unknown>,
          }
        : null;

      // APIs exposed
      const apiResult = await session.run(
        `MATCH (s:Service {name: $name})-[:EXPOSES]->(a:API)
         RETURN a.name AS name, 'API' AS label, properties(a) AS properties`,
        { name: serviceName },
      );
      const apis = apiResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Databases used
      const dbResult = await session.run(
        `MATCH (s:Service {name: $name})-[:USES]->(d:Database)
         RETURN d.name AS name, 'Database' AS label, properties(d) AS properties`,
        { name: serviceName },
      );
      const databases = dbResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Outgoing dependencies
      const depResult = await session.run(
        `MATCH (s:Service {name: $name})-[:CALLS|DEPENDS_ON]->(t)
         RETURN t.name AS name, labels(t)[0] AS label, properties(t) AS properties`,
        { name: serviceName },
      );
      const dependencies = depResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      // Incoming dependents
      const dependentResult = await session.run(
        `MATCH (t)-[:CALLS|DEPENDS_ON]->(s:Service {name: $name})
         RETURN t.name AS name, labels(t)[0] AS label, properties(t) AS properties`,
        { name: serviceName },
      );
      const dependents = dependentResult.records.map((r) => ({
        name: r.get('name') as string,
        label: r.get('label') as string,
        properties: r.get('properties') as Record<string, unknown>,
      }));

      return { service, apis, databases, dependencies, dependents };
    } finally {
      await session.close();
    }
  }

  /**
   * List all API endpoints, optionally filtered by service.
   */
  async getApiMap(serviceName?: string): Promise<readonly QueryResult[]> {
    const session = this.client.getReadSession();
    try {
      const query = serviceName
        ? `MATCH (s:Service {name: $serviceName})-[:EXPOSES]->(a:API)
           RETURN a.name AS name, 'API' AS label, properties(a) AS properties
           ORDER BY a.path`
        : `MATCH (a:API)
           RETURN a.name AS name, 'API' AS label, properties(a) AS properties
           ORDER BY a.path`;

      const result = await session.run(query, { serviceName: serviceName ?? '' });

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
