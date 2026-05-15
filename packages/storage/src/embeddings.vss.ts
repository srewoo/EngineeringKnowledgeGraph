/**
 * Optional sqlite-vss ANN adapter for `EmbeddingsRepository`.
 *
 * Lazy-loads `sqlite-vss` only when `EKG_VECTOR_INDEX=vss`. If the native
 * module isn't built for the host platform, logs a warn and degrades to a
 * no-op so callers fall back to the brute-force JS cosine path. Default
 * mode (`brute`) pays zero startup cost — the virtual table is never created.
 *
 * Mirroring strategy: on `mirrorUpsert`, we copy each embedding row into a
 * `vss_embeddings(rowid, vector)` virtual table keyed by the same id-as-rowid
 * mapping (rowid is sqlite's implicit pk on the embeddings table). On search,
 * we run `vss_search` to get rowids and JOIN back to `embeddings` for the row
 * data, then compute final cosine on the JS side for parity with the brute
 * path.
 */

import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { createLogger, type Logger } from '@ekg/shared';

const requireSync = createRequire(import.meta.url);

export type VectorIndexMode = 'brute' | 'vss';

export function readVectorIndexMode(env: NodeJS.ProcessEnv = process.env): VectorIndexMode {
  const raw = (env['EKG_VECTOR_INDEX'] ?? 'brute').toLowerCase();
  return raw === 'vss' ? 'vss' : 'brute';
}

export interface VssRow {
  readonly rowid: number;
  readonly vector: Buffer;
}

export interface VssAdapter {
  readonly available: boolean;
  ensureSchema(dimensions: number): void;
  mirrorUpsert(rowid: number, vector: Buffer): void;
  mirrorDelete(rowids: readonly number[]): void;
  /** Returns candidate rowids ranked by ANN score; caller JOINs back. */
  search(query: Float32Array, k: number): readonly number[];
  close(): void;
}

interface SqliteVssModule {
  load(db: Database.Database): void;
}

/**
 * Lazy factory. Never throws — failure to load the native module degrades
 * to an unavailable adapter the caller skips.
 */
export function createVssAdapter(db: Database.Database, logger?: Logger): VssAdapter {
  const log = logger ?? createLogger({ service: 'embeddings-vss' });

  let mod: SqliteVssModule | undefined;
  try {
    const required = requireSync('sqlite-vss') as SqliteVssModule;
    required.load(db);
    mod = required;
  } catch (err) {
    log.warn(
      { err: errMsg(err) },
      'sqlite-vss not available — falling back to brute-force cosine. Set EKG_VECTOR_INDEX=brute to silence.',
    );
    return unavailableAdapter();
  }

  let schemaDims = 0;
  return {
    available: true,
    ensureSchema(dimensions: number): void {
      if (schemaDims === dimensions) return;
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vss_embeddings USING vss0(
            vector(${dimensions})
          );
        `);
        schemaDims = dimensions;
      } catch (err) {
        log.warn({ err: errMsg(err), dimensions }, 'Failed to create vss virtual table');
      }
    },
    mirrorUpsert(rowid: number, vector: Buffer): void {
      try {
        db.prepare('INSERT OR REPLACE INTO vss_embeddings (rowid, vector) VALUES (?, ?)').run(rowid, vector);
      } catch (err) {
        log.warn({ err: errMsg(err), rowid }, 'vss mirror upsert failed');
      }
    },
    mirrorDelete(rowids: readonly number[]): void {
      if (rowids.length === 0) return;
      try {
        const placeholders = rowids.map(() => '?').join(',');
        db.prepare(`DELETE FROM vss_embeddings WHERE rowid IN (${placeholders})`).run(...rowids);
      } catch (err) {
        log.warn({ err: errMsg(err), count: rowids.length }, 'vss mirror delete failed');
      }
    },
    search(query: Float32Array, k: number): readonly number[] {
      try {
        const buf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
        const rows = db.prepare(
          `SELECT rowid FROM vss_embeddings WHERE vss_search(vector, ?) LIMIT ?`,
        ).all(buf, k) as Array<{ rowid: number }>;
        return rows.map((r) => r.rowid);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'vss_search failed; caller should fall back to brute');
        return [];
      }
    },
    close(): void {
      // sqlite-vss attaches functions; no explicit close required.
      mod = undefined;
    },
  };
}

function unavailableAdapter(): VssAdapter {
  return {
    available: false,
    ensureSchema: () => undefined,
    mirrorUpsert: () => undefined,
    mirrorDelete: () => undefined,
    search: () => [],
    close: () => undefined,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
