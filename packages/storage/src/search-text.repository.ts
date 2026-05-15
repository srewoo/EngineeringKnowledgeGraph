/**
 * SearchTextRepository — BM25 full-text search over node names/paths/bodies.
 *
 * Uses SQLite FTS5 (porter + unicode61 tokeniser). Indexes the same content
 * as the embedder so vector + BM25 see consistent text. Brute-force
 * sufficient for laptop scale; swap to tantivy / Elasticsearch later without
 * touching call sites.
 */

import Database from 'better-sqlite3';
import { createLogger, type Logger } from '@ekg/shared';

export interface SearchTextRow {
  readonly label: string;
  readonly nodeId: string;
  readonly repoUrl: string;
  readonly name: string;
  readonly path: string;
  readonly body: string;
}

export interface Bm25Hit {
  readonly label: string;
  readonly nodeId: string;
  readonly repoUrl: string;
  readonly score: number;
  readonly name: string;
  readonly path: string;
}

export interface Bm25Options {
  readonly label?: string;
  readonly repoUrl?: string;
  readonly k?: number;
}

const DEFAULT_K = 50;
const MAX_K = 200;
const DELETE_CHUNK_SIZE = 500;

export class SearchTextRepository {
  private readonly db: Database.Database;
  private readonly logger: Logger;

  constructor(dbPath: string) {
    this.logger = createLogger({ service: 'search-text-repository' });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  /** Tests can share a connection with other repos. */
  static fromConnection(db: Database.Database): SearchTextRepository {
    const repo = Object.create(SearchTextRepository.prototype) as SearchTextRepository;
    Object.assign(repo, {
      db,
      logger: createLogger({ service: 'search-text-repository' }),
    });
    db.pragma('journal_mode = WAL');
    (repo as unknown as { initTables: () => void }).initTables();
    return repo;
  }

  private initTables(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(
        label UNINDEXED,
        node_id UNINDEXED,
        repo_url UNINDEXED,
        name,
        path,
        body,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Idempotent index. Deletes any existing rows for the same node_id, then
   * inserts. FTS5 has no UPSERT — delete-then-insert is the standard pattern.
   */
  index(rows: readonly SearchTextRow[]): void {
    if (rows.length === 0) return;
    const del = this.db.prepare('DELETE FROM search_text WHERE node_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO search_text (label, node_id, repo_url, name, path, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((batch: readonly SearchTextRow[]) => {
      for (const r of batch) {
        del.run(r.nodeId);
        ins.run(r.label, r.nodeId, r.repoUrl, r.name, r.path, r.body);
      }
    });
    tx(rows);
  }

  /**
   * BM25 search. FTS5's `bm25()` returns a *cost* (lower is better); we
   * negate it so callers can treat higher = better, like vector cosine.
   */
  searchBm25(query: string, opts: Bm25Options = {}): readonly Bm25Hit[] {
    const sanitised = sanitiseFtsQuery(query);
    if (!sanitised) return [];
    const k = Math.max(1, Math.min(opts.k ?? DEFAULT_K, MAX_K));

    const where: string[] = ['search_text MATCH ?'];
    const params: unknown[] = [sanitised];
    if (opts.label) {
      where.push('label = ?');
      params.push(opts.label);
    }
    if (opts.repoUrl) {
      where.push('repo_url = ?');
      params.push(opts.repoUrl);
    }
    params.push(k);

    const sql = `
      SELECT label, node_id, repo_url, name, path, bm25(search_text) AS rank
      FROM search_text
      WHERE ${where.join(' AND ')}
      ORDER BY rank ASC
      LIMIT ?
    `;
    try {
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        label: r['label'] as string,
        nodeId: r['node_id'] as string,
        repoUrl: r['repo_url'] as string,
        name: (r['name'] as string) ?? '',
        path: (r['path'] as string) ?? '',
        score: -(r['rank'] as number),
      }));
    } catch (err) {
      this.logger.warn({ err: errMsg(err), query }, 'BM25 query failed');
      return [];
    }
  }

  deleteByRepo(repoUrl: string): number {
    const info = this.db.prepare('DELETE FROM search_text WHERE repo_url = ?').run(repoUrl);
    this.logger.info({ repoUrl, deleted: info.changes }, 'BM25 rows deleted for repo');
    return info.changes;
  }

  /** Bulk delete by node id, chunked at 500 to keep parameter counts safe. */
  deleteByNodeIds(nodeIds: readonly string[]): number {
    if (nodeIds.length === 0) return 0;
    let total = 0;
    const tx = this.db.transaction((chunk: readonly string[]) => {
      const placeholders = chunk.map(() => '?').join(',');
      const sql = `DELETE FROM search_text WHERE node_id IN (${placeholders})`;
      const info = this.db.prepare(sql).run(...chunk);
      total += info.changes;
    });
    for (let i = 0; i < nodeIds.length; i += DELETE_CHUNK_SIZE) {
      tx(nodeIds.slice(i, i + DELETE_CHUNK_SIZE));
    }
    if (total > 0) {
      this.logger.info({ count: nodeIds.length, deleted: total }, 'BM25 rows deleted by node ids');
    }
    return total;
  }

  /** All distinct node ids indexed for a given repo. */
  listNodeIdsByRepo(repoUrl: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT node_id AS nodeId FROM search_text WHERE repo_url = ?',
    ).all(repoUrl) as Array<{ nodeId: string }>;
    return rows.map((r) => r.nodeId);
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM search_text').get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * FTS5 MATCH syntax is strict — bare `:` or `"` in user input throws.
 * We strip operators and quote each surviving token, then OR them together.
 * This is safe (parameterised) and forgiving for natural-language queries.
 */
export function sanitiseFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/["()*:^]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  // Quote each token to escape FTS keywords like AND/OR/NOT/NEAR.
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
