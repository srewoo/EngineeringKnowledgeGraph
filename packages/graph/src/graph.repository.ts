/**
 * Graph repository — CRUD operations on the knowledge graph.
 *
 * Writes are batched with UNWIND so a single Cypher round-trip handles
 * thousands of nodes/relationships per tx. Cleanup is scoped per repo
 * to avoid full-graph scans during incremental ingest.
 */

import { createLogger, metrics, LOCAL_REQUEST_CONTEXT } from '@ekg/shared';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType, Logger, RequestContext } from '@ekg/shared';
import { Neo4jClient } from './neo4j.client.js';

const NODE_BATCH_SIZE = 500;
const REL_BATCH_SIZE = 500;

/**
 * Hard cap on UNWIND chunk size shipped per-transaction.
 *
 * Neo4j enforces a server-side transaction timeout (10 min in this deploy).
 * Above ~5K rows in a single MERGE tx we have repeatedly seen tx-timeouts
 * and Forseti exclusive-lock contention on Service nodes when concurrent
 * write workers touch the same hot node. Splitting per chunk keeps each
 * tx short and releases locks frequently.
 */
export const MAX_UNWIND_CHUNK_SIZE = 5_000;

/**
 * Phase B: shape required by `writeMrSubgraph`. Decoupled from `MrNode` so
 * callers don't have to import shared types just to construct an input
 * record — and so the schema is documented locally next to the writer.
 */
export interface MrSubgraphInput {
  readonly id: string;
  readonly name: string;
  readonly properties: Readonly<{
    iid: number;
    projectPath: string;
    title: string;
    state: string;
    author: string;
    sourceBranch: string;
    targetBranch: string;
    headSha: string | null;
    labels: readonly string[];
    webUrl: string;
    createdAt: string | null;
    updatedAt: string | null;
    filesChanged: number;
    diffSize: number;
  }>;
}

/**
 * Pure helper — splits an array into fixed-size chunks. Returns an empty
 * list when input is empty so callers can `for…of` without a guard.
 * Throws on size <= 0 — silent fallback would mean one giant chunk.
 */
export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunkRows: size must be > 0, got ${size}`);
  if (rows.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

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
  async mergeNodes(nodes: readonly GraphNode[], ctx: RequestContext = LOCAL_REQUEST_CONTEXT): Promise<number> {
    if (nodes.length === 0) return 0;

    // Group by label — each label needs its own MERGE clause
    const byLabel = new Map<NodeLabel, GraphNode[]>();
    for (const n of nodes) {
      let bucket = byLabel.get(n.label);
      if (!bucket) { bucket = []; byLabel.set(n.label, bucket); }
      bucket.push(n);
    }

    // Phase 2 multi-tenant: when an `id` is shared across tenants, the
    // existing `MERGE (n:Label {id: row.id})` would collapse them. We
    // therefore scope the merge key with `tenantId` for non-local
    // contexts. The `id` property itself still gets set so existing
    // single-property indexes (`Service.id`) keep working; the *merge
    // key* is the pair (id, tenantId).
    const tenantId = ctx.tenantId;

    let total = 0;
    for (const [label, bucket] of byLabel) {
      const innerBatches = chunkRows(bucket, NODE_BATCH_SIZE);
      const totalChunks = innerBatches.length;
      for (let chunkIndex = 0; chunkIndex < innerBatches.length; chunkIndex++) {
        const batch = innerBatches[chunkIndex]!;
        if (batch.length > MAX_UNWIND_CHUNK_SIZE) {
          throw new Error(`Node batch ${batch.length} exceeds MAX_UNWIND_CHUNK_SIZE`);
        }
        const rows = batch.map((n) => ({
          id: n.id,
          name: n.name,
          // Stamp tenantId onto the property bag so it survives `n += row.properties`.
          properties: { ...n.properties, tenantId },
        }));

        const startedAt = Date.now();
        await this.client.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $rows AS row
             MERGE (n:${label} {id: row.id, tenantId: $tenantId})
             SET n.name = row.name,
                 n += row.properties,
                 n.updatedAt = datetime()`,
            { rows, tenantId },
          );
        });
        const latencyMs = Date.now() - startedAt;
        this.logger.debug({
          label, chunkIndex, chunkSize: batch.length, totalChunks, latencyMs, tenantId,
        }, 'Node UNWIND chunk merged');
        total += batch.length;
      }
    }

    this.logger.info({ count: total, labels: byLabel.size, tenantId }, 'Batch node merge completed');
    metrics.inc('graph.nodes.merged', total);
    return total;
  }

  async mergeRelationship(rel: GraphRelationship): Promise<void> {
    await this.mergeRelationships([rel]);
  }

  /**
   * Batch-merge relationships. Groups by type so each type is one Cypher call.
   */
  async mergeRelationships(rels: readonly GraphRelationship[], ctx: RequestContext = LOCAL_REQUEST_CONTEXT): Promise<number> {
    if (rels.length === 0) return 0;

    const byType = new Map<RelationshipType, GraphRelationship[]>();
    for (const r of rels) {
      let bucket = byType.get(r.type);
      if (!bucket) { bucket = []; byType.set(r.type, bucket); }
      bucket.push(r);
    }

    const tenantId = ctx.tenantId;

    let total = 0;
    for (const [type, bucket] of byType) {
      const innerBatches = chunkRows(bucket, REL_BATCH_SIZE);
      const totalChunks = innerBatches.length;
      for (let chunkIndex = 0; chunkIndex < innerBatches.length; chunkIndex++) {
        const batch = innerBatches[chunkIndex]!;
        if (batch.length > MAX_UNWIND_CHUNK_SIZE) {
          throw new Error(`Relationship batch ${batch.length} exceeds MAX_UNWIND_CHUNK_SIZE`);
        }
        const rows = batch.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          confidence: r.confidence,
          properties: { ...r.properties, tenantId },
        }));

        const startedAt = Date.now();
        await this.client.executeWrite(async (tx) => {
          // Phase 2 multi-tenant: MATCH endpoints by (id, tenantId) so a
          // relationship can never cross tenant boundaries even if two
          // tenants happen to have the same node id.
          await tx.run(
            `UNWIND $rows AS row
             MATCH (source {id: row.sourceId, tenantId: $tenantId})
             MATCH (target {id: row.targetId, tenantId: $tenantId})
             MERGE (source)-[r:${type}]->(target)
             SET r.confidence = row.confidence,
                 r += row.properties,
                 r.updatedAt = datetime()`,
            { rows, tenantId },
          );
        });
        const latencyMs = Date.now() - startedAt;
        this.logger.debug({
          type, chunkIndex, chunkSize: batch.length, totalChunks, latencyMs, tenantId,
        }, 'Relationship UNWIND chunk merged');
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

  /**
   * Phase B: write a single MR + its author (Owner) + AUTHORED_MR edge,
   * and a MERGED_AS edge to the head Commit *only when that Commit already
   * exists* in the graph. We never create stub Commits — a missing commit
   * means git history wasn't ingested for that repo and the edge would be
   * misleading.
   *
   * Idempotent: re-calling with the same MR overwrites scalar properties
   * but preserves edges.
   *
   * Returns the number of edges actually created or refreshed.
   */
  async writeMrSubgraph(input: {
    mr: MrSubgraphInput;
    author: { id: string; identifier: string; kind: 'user' | 'team' | 'email'; repoUrl: string };
  }): Promise<{ mrMerged: boolean; authoredMerged: boolean; mergedAsCreated: boolean }> {
    const { mr, author } = input;

    return this.client.executeWrite(async (tx) => {
      // 1. Upsert MR + Owner + AUTHORED_MR in one Cypher.
      await tx.run(
        `MERGE (mr:MR {id: $mr.id})
         SET mr += $mr.properties, mr.name = $mr.name, mr.updatedAt = datetime()
         MERGE (o:Owner {id: $author.id})
         SET o.identifier = $author.identifier,
             o.kind = $author.kind,
             o.repoUrl = $author.repoUrl,
             o.name = $author.identifier,
             o.updatedAt = datetime()
         MERGE (o)-[r:AUTHORED_MR]->(mr)
         SET r.confidence = 'HIGH', r.updatedAt = datetime()`,
        { mr, author },
      );

      // 2. Conditional MERGED_AS — only if a Commit with the head sha exists.
      let mergedAsCreated = false;
      if (mr.properties.headSha) {
        const result = await tx.run(
          `MATCH (c:Commit {sha: $headSha})
           WITH c LIMIT 1
           MATCH (mr:MR {id: $mrId})
           MERGE (mr)-[r:MERGED_AS]->(c)
           SET r.confidence = 'HIGH', r.updatedAt = datetime()
           RETURN count(r) AS edges`,
          { headSha: mr.properties.headSha, mrId: mr.id },
        );
        mergedAsCreated = ((result.records[0]?.get('edges') as { toNumber?: () => number } | undefined)?.toNumber?.() ?? 0) > 0;
      }

      return { mrMerged: true, authoredMerged: true, mergedAsCreated };
    });
  }

  /**
   * Phase D: mirror embedding vectors onto graph nodes so similarity search
   * can run natively in Neo4j (via vector index) and traversals can mix
   * structural filters with semantic ranking.
   *
   * Idempotent. Skips silently when the input is empty. Groups by label so
   * each label's vector index can be assumed to exist before this is called
   * (caller should `ensureVectorIndex(label, dim)` for the labels they're
   * writing).
   *
   * Stores 4 properties per node:
   *   - `embedding`      Float[] — the vector
   *   - `embeddingDim`   int     — dimension count (sanity check at query time)
   *   - `embeddingProvider` str — provider:model that produced it
   *   - `embeddingHash`  str     — content hash from the embedder; used by
   *                                downstream code to invalidate cheaply.
   *
   * Returns how many nodes had vectors written.
   */
  async writeNodeEmbeddings(rows: ReadonlyArray<{
    nodeId: string;
    label: string;
    vector: readonly number[];
    provider: string;
    contentHash: string;
  }>): Promise<number> {
    if (rows.length === 0) return 0;
    const byLabel = new Map<string, typeof rows[number][]>();
    for (const r of rows) {
      let b = byLabel.get(r.label);
      if (!b) { b = []; byLabel.set(r.label, b); }
      b.push(r);
    }
    let total = 0;
    for (const [, bucket] of byLabel) {
      for (const chunk of chunkRows(bucket, NODE_BATCH_SIZE)) {
        const payload = chunk.map((r) => ({
          nodeId: r.nodeId,
          vector: r.vector,
          dim: r.vector.length,
          provider: r.provider,
          hash: r.contentHash,
        }));
        await this.client.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (n {id: row.nodeId})
             SET n.embedding = row.vector,
                 n.embeddingDim = row.dim,
                 n.embeddingProvider = row.provider,
                 n.embeddingHash = row.hash,
                 n.embeddingUpdatedAt = datetime()`,
            { rows: payload },
          );
        });
        total += chunk.length;
      }
    }
    this.logger.info({ count: total, labels: byLabel.size }, 'Vector mirror to graph complete');
    metrics.inc('graph.vectors.written', total);
    return total;
  }

  /**
   * Phase D: lazily create a Neo4j 5 native vector index for a label on the
   * `embedding` property. Cheap if already exists (CREATE INDEX IF NOT EXISTS).
   *
   * `dimensions` must match the vector being stored. Mismatches at query
   * time will return empty rather than error, which is why we also assert
   * `n.embeddingDim = $dim` in vector reads.
   */
  async ensureVectorIndex(label: string, dimensions: number, similarity: 'cosine' | 'euclidean' = 'cosine'): Promise<void> {
    const indexName = `${label.toLowerCase()}_embedding_vec`;
    const session = this.client.getSession();
    try {
      await session.run(
        `CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
         FOR (n:${label}) ON (n.embedding)
         OPTIONS { indexConfig: {
           \`vector.dimensions\`: $dim,
           \`vector.similarity_function\`: $sim
         }}`,
        { dim: dimensions, sim: similarity },
      );
      this.logger.info({ label, dim: dimensions, sim: similarity, indexName }, 'Vector index ensured');
    } catch (err) {
      // Native vector index requires Neo4j 5.13+. Fail soft so older deployments
      // still get the vector property (brute-force similarity remains an option
      // via the SQLite embeddings store).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ label, err: msg }, 'Vector index creation skipped (older Neo4j?)');
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
        'CREATE INDEX IF NOT EXISTS FOR (n:API) ON (n.specPath)',
        'CREATE INDEX IF NOT EXISTS FOR (n:API) ON (n.operationId)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Config) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Repo) ON (n.url)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Owner) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Owner) ON (n.identifier)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Team) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Team) ON (n.name)',
        // Phase 1.7 — Commit nodes
        'CREATE INDEX IF NOT EXISTS FOR (n:Commit) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Commit) ON (n.sha)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Commit) ON (n.authoredAt)',
        // Phase B — MR nodes
        'CREATE INDEX IF NOT EXISTS FOR (n:MR) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:MR) ON (n.projectPath)',
        'CREATE INDEX IF NOT EXISTS FOR (n:MR) ON (n.state)',
        'CREATE INDEX IF NOT EXISTS FOR (n:MR) ON (n.updatedAt)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Doc) ON (n.kind)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Table) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Column) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Column) ON (n.tableId)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Migration) ON (n.id)',
        // Phase 1.5 — Kafka topic indexes
        'CREATE INDEX IF NOT EXISTS FOR (n:Topic) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Topic) ON (n.name)',
        // Phase 1.3 — function-level symbol indexes
        'CREATE INDEX IF NOT EXISTS FOR (n:Function) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Function) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Function) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Class) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Class) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Class) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Method) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:Method) ON (n.classId)',
        'CREATE INDEX IF NOT EXISTS FOR (n:TypeDef) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:TypeDef) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:TypeDef) ON (n.name)',
        // Phase 1.6 — config & secret indexes
        'CREATE INDEX IF NOT EXISTS FOR (n:ConfigKey) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:ConfigKey) ON (n.key)',
        'CREATE INDEX IF NOT EXISTS FOR (n:ConfigKey) ON (n.repoUrl)',
        'CREATE INDEX IF NOT EXISTS FOR (n:SecretRef) ON (n.id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:SecretRef) ON (n.vendor)',
        'CREATE INDEX IF NOT EXISTS FOR (n:SecretRef) ON (n.ref)',
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
