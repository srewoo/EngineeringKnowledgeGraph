/**
 * Graph repository — CRUD operations on the knowledge graph.
 *
 * Writes are batched with UNWIND so a single Cypher round-trip handles
 * thousands of nodes/relationships per tx. Cleanup is scoped per repo
 * to avoid full-graph scans during incremental ingest.
 */

import { createLogger, metrics } from '@ekg/shared';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType, Logger } from '@ekg/shared';
import { Neo4jClient } from './neo4j.client.js';

const NODE_BATCH_SIZE = 500;
const REL_BATCH_SIZE = 500;

export class GraphRepository {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'graph-repository' });
  }

  /** Idempotent merge of a single node — kept for one-off writes. */
  async mergeNode(node: GraphNode): Promise<void> {
    await this.mergeNodes([node]);
  }

  /**
   * Batch-merge nodes. Groups by label, then UNWINDs rows so each label/batch
   * is a single Cypher call. ~100× faster than one tx.run per node.
   */
  async mergeNodes(nodes: readonly GraphNode[]): Promise<number> {
    if (nodes.length === 0) return 0;

    // Group by label — each label needs its own MERGE clause
    const byLabel = new Map<NodeLabel, GraphNode[]>();
    for (const n of nodes) {
      let bucket = byLabel.get(n.label);
      if (!bucket) { bucket = []; byLabel.set(n.label, bucket); }
      bucket.push(n);
    }

    let total = 0;
    for (const [label, bucket] of byLabel) {
      for (let i = 0; i < bucket.length; i += NODE_BATCH_SIZE) {
        const batch = bucket.slice(i, i + NODE_BATCH_SIZE);
        const rows = batch.map((n) => ({
          id: n.id,
          name: n.name,
          properties: n.properties,
        }));

        await this.client.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $rows AS row
             MERGE (n:${label} {id: row.id})
             SET n.name = row.name,
                 n += row.properties,
                 n.updatedAt = datetime()`,
            { rows },
          );
        });
        total += batch.length;
      }
    }

    this.logger.info({ count: total, labels: byLabel.size }, 'Batch node merge completed');
    metrics.inc('graph.nodes.merged', total);
    return total;
  }

  async mergeRelationship(rel: GraphRelationship): Promise<void> {
    await this.mergeRelationships([rel]);
  }

  /**
   * Batch-merge relationships. Groups by type so each type is one Cypher call.
   */
  async mergeRelationships(rels: readonly GraphRelationship[]): Promise<number> {
    if (rels.length === 0) return 0;

    const byType = new Map<RelationshipType, GraphRelationship[]>();
    for (const r of rels) {
      let bucket = byType.get(r.type);
      if (!bucket) { bucket = []; byType.set(r.type, bucket); }
      bucket.push(r);
    }

    let total = 0;
    for (const [type, bucket] of byType) {
      for (let i = 0; i < bucket.length; i += REL_BATCH_SIZE) {
        const batch = bucket.slice(i, i + REL_BATCH_SIZE);
        const rows = batch.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          confidence: r.confidence,
          properties: r.properties,
        }));

        await this.client.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (source {id: row.sourceId})
             MATCH (target {id: row.targetId})
             MERGE (source)-[r:${type}]->(target)
             SET r.confidence = row.confidence,
                 r += row.properties,
                 r.updatedAt = datetime()`,
            { rows },
          );
        });
        total += batch.length;
      }
    }

    this.logger.info({ count: total, types: byType.size }, 'Batch relationship merge completed');
    metrics.inc('graph.edges.merged', total);
    return total;
  }

  /**
   * Delete all File nodes (and their incident edges) for a list of file paths
   * in one round-trip. Used during incremental re-ingestion.
   */
  async deleteBySourceFile(filePath: string, repoUrl: string): Promise<number> {
    return this.deleteBySourceFiles([filePath], repoUrl);
  }

  async deleteBySourceFiles(filePaths: readonly string[], repoUrl: string): Promise<number> {
    if (filePaths.length === 0) return 0;
    const ids = filePaths.map((p) => `${repoUrl}:${p}`);
    const session = this.client.getSession();
    try {
      const result = await session.run(
        `UNWIND $ids AS id
         MATCH (n:File {id: id})
         DETACH DELETE n
         RETURN count(n) as deleted`,
        { ids },
      );
      const deleted = result.records[0]?.get('deleted')?.toNumber() ?? 0;
      this.logger.info({ repoUrl, deleted, count: filePaths.length }, 'Deleted file nodes (batch)');
      return deleted;
    } finally {
      await session.close();
    }
  }

  /**
   * Remove orphan nodes scoped to a single repo — no full-graph scan.
   * Targets File/Module/API/Config/Database nodes that lost all incident edges
   * after an incremental re-ingest.
   */
  async cleanupOrphans(repoUrl?: string): Promise<number> {
    const session = this.client.getSession();
    try {
      const cypher = repoUrl
        ? `MATCH (n)
           WHERE (n.repoUrl = $repoUrl OR n.id STARTS WITH $repoUrl)
             AND NOT (n)--()
             AND NOT n:Repo
             AND NOT n:Service
           DELETE n
           RETURN count(n) as deleted`
        : `MATCH (n)
           WHERE NOT (n)--()
             AND NOT n:Repo
             AND NOT n:Service
           DELETE n
           RETURN count(n) as deleted`;

      const result = await session.run(cypher, { repoUrl: repoUrl ?? '' });
      const deleted = result.records[0]?.get('deleted')?.toNumber() ?? 0;
      this.logger.info({ deleted, repoUrl }, 'Orphan cleanup completed');
      return deleted;
    } finally {
      await session.close();
    }
  }

  async initIndexes(): Promise<void> {
    const session = this.client.getSession();
    try {
      const indexes = [
        'CREATE INDEX IF NOT EXISTS FOR (n:Service) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Service) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:File) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:File) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Module) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Module) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Database) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:API) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:API) ON (n.path)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Config) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Repo) ON (n.url)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Owner) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Team) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.kind)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Column) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Column) ON (n.tableId)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Migration) ON (n.id)',
      ];
      for (const query of indexes) {
        await session.run(query);
      }
      this.logger.info('Graph indexes initialised');
    } finally {
      await session.close();
    }
  }

  async getStats(): Promise<{ nodes: number; edges: number }> {
    const session = this.client.getReadSession();
    try {
      const nodeResult = await session.run('MATCH (n) RETURN count(n) as count');
      const edgeResult = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
      return {
        nodes: nodeResult.records[0]?.get('count')?.toNumber() ?? 0,
        edges: edgeResult.records[0]?.get('count')?.toNumber() ?? 0,
      };
    } finally {
      await session.close();
    }
  }
}
