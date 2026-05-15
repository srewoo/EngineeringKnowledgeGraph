/**
 * Embeddings repository.
 *
 * Stores per-node vector embeddings as Float32 BLOBs alongside their
 * provider/model/dimensions and the raw text used. Brute-force cosine
 * similarity in JS — sufficient for laptop-scale (≤200K rows). Swap to
 * sqlite-vss / pgvector later without changing the call sites.
 */

import Database from 'better-sqlite3';
import { createLogger, type Logger } from '@ekg/shared';

export interface EmbeddingRow {
  readonly id: string;
  readonly label: string;
  readonly nodeId: string;
  readonly repoUrl: string;
  readonly contentHash: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly vector: Buffer;
  readonly textUsed: string;
  readonly createdAt: string;
}

export interface SimilarityHit {
  readonly row: EmbeddingRow;
  readonly score: number;
}

export class EmbeddingsRepository {
  private readonly db: Database.Database;
  private readonly logger: Logger;

  constructor(dbPath: string) {
    this.logger = createLogger({ service: 'embeddings-repository' });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  /** For tests: share an existing better-sqlite3 connection. */
  static fromConnection(db: Database.Database): EmbeddingsRepository {
    const repo = Object.create(EmbeddingsRepository.prototype) as EmbeddingsRepository;
    Object.assign(repo, {
      db,
      logger: createLogger({ service: 'embeddings-repository' }),
    });
    db.pragma('journal_mode = WAL');
    (repo as unknown as { initTables: () => void }).initTables();
    return repo;
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        node_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        text_used TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_label ON embeddings(label);
      CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON embeddings(repo_url);
      CREATE INDEX IF NOT EXISTS idx_embeddings_node ON embeddings(node_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
    `);
  }

  upsert(rows: readonly EmbeddingRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO embeddings
        (id, label, node_id, repo_url, content_hash, provider, model, dimensions, vector, text_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        label = excluded.label,
        node_id = excluded.node_id,
        repo_url = excluded.repo_url,
        content_hash = excluded.content_hash,
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        vector = excluded.vector,
        text_used = excluded.text_used,
        created_at = excluded.created_at
    `);
    const tx = this.db.transaction((batch: readonly EmbeddingRow[]) => {
      for (const r of batch) {
        stmt.run(
          r.id, r.label, r.nodeId, r.repoUrl, r.contentHash,
          r.provider, r.model, r.dimensions, r.vector, r.textUsed, r.createdAt,
        );
      }
    });
    tx(rows);
  }

  findByContentHash(hash: string): EmbeddingRow | undefined {
    const row = this.db.prepare('SELECT * FROM embeddings WHERE content_hash = ? LIMIT 1').get(hash) as
      Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByNodeId(nodeId: string): EmbeddingRow | undefined {
    const row = this.db.prepare('SELECT * FROM embeddings WHERE node_id = ? LIMIT 1').get(nodeId) as
      Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Brute-force cosine similarity. O(N) per query — fine for laptop-scale.
   * Filters by label and/or repo before scoring to keep N small.
   */
  searchSimilar(
    query: Float32Array,
    options: { readonly label?: string; readonly repoUrl?: string; readonly k?: number } = {},
  ): readonly SimilarityHit[] {
    const k = Math.max(1, Math.min(options.k ?? 10, 100));
    const filters: string[] = ['dimensions = ?'];
    const params: unknown[] = [query.length];
    if (options.label) { filters.push('label = ?'); params.push(options.label); }
    if (options.repoUrl) { filters.push('repo_url = ?'); params.push(options.repoUrl); }
    const where = `WHERE ${filters.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM embeddings ${where}`).all(...params) as Record<string, unknown>[];

    const queryNorm = norm(query);
    if (queryNorm === 0) return [];

    const scored: SimilarityHit[] = [];
    for (const raw of rows) {
      const row = mapRow(raw);
      const vec = bufferToFloat32(row.vector);
      if (vec.length !== query.length) continue;
      const score = cosine(query, vec, queryNorm);
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  deleteByRepo(repoUrl: string): number {
    const info = this.db.prepare('DELETE FROM embeddings WHERE repo_url = ?').run(repoUrl);
    this.logger.info({ repoUrl, deleted: info.changes }, 'Embeddings deleted for repo');
    return info.changes;
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(row: Record<string, unknown>): EmbeddingRow {
  return {
    id: row['id'] as string,
    label: row['label'] as string,
    nodeId: row['node_id'] as string,
    repoUrl: row['repo_url'] as string,
    contentHash: row['content_hash'] as string,
    provider: row['provider'] as string,
    model: row['model'] as string,
    dimensions: row['dimensions'] as number,
    vector: row['vector'] as Buffer,
    textUsed: row['text_used'] as string,
    createdAt: row['created_at'] as string,
  };
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy to a fresh ArrayBuffer to guarantee 4-byte alignment.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

function cosine(a: Float32Array, b: Float32Array, aNorm: number): number {
  let dot = 0;
  let bSum = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    bSum += bv * bv;
  }
  const bNorm = Math.sqrt(bSum);
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}
