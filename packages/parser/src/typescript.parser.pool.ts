/**
 * TypeScriptParserPool — round-robin worker-thread pool over the TS parser.
 *
 * Why: ts-morph AST work is CPU-bound. A 400-repo bulk run pegs a single
 * Node thread; spreading across (cpus - 1) workers gets near-linear speedup.
 *
 * Failure modes are handled defensively:
 *   - If the worker entry can't be located (e.g. tests running from src/
 *     before build), the pool transparently falls back to in-process parsing
 *     so behaviour is identical.
 *   - If a worker dies mid-parse, the in-flight request rejects and the
 *     replacement worker is started lazily on the next request.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, metrics } from '@ekg/shared';
import type { Logger, ParseResult } from '@ekg/shared';
import { TypeScriptParser } from './typescript.parser.js';

interface PendingRequest {
  resolve(result: ParseResult): void;
  reject(error: Error): void;
}

interface PooledWorker {
  worker: Worker;
  inflight: number;
}

export interface PoolOptions {
  /** Worker count. Defaults to max(1, cpus - 1). */
  readonly size?: number;
}

export class TypeScriptParserPool {
  private readonly workers: PooledWorker[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly logger: Logger;
  private readonly fallback: TypeScriptParser;
  private readonly workerEntry: string | undefined;
  private nextId = 0;
  private rrIndex = 0;
  private closed = false;

  constructor(options?: PoolOptions) {
    this.logger = createLogger({ service: 'typescript-parser-pool' });
    this.fallback = new TypeScriptParser();

    const cpus = (() => { try { return require('node:os').cpus().length; } catch { return 4; } })();
    const desired = options?.size ?? Math.max(1, cpus - 1);

    this.workerEntry = this.locateWorkerEntry();
    if (!this.workerEntry) {
      this.logger.info('Worker entry not found — pool will run in-process (single-thread fallback)');
      return;
    }

    for (let i = 0; i < desired; i++) {
      this.workers.push(this.spawn());
    }
    this.logger.info({ size: this.workers.length, entry: this.workerEntry }, 'TypeScript parser pool ready');
    metrics.set('parser.pool.size', this.workers.length);
  }

  /** Parse a single file via the next worker in round-robin order. */
  async parseFile(filePath: string): Promise<ParseResult> {
    if (this.closed || this.workers.length === 0) {
      return this.fallback.parseFile(filePath);
    }

    const id = ++this.nextId;
    const pooled = this.workers[this.rrIndex % this.workers.length]!;
    this.rrIndex++;
    pooled.inflight++;

    return new Promise<ParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      pooled.worker.postMessage({ id, filePath });
    }).finally(() => { pooled.inflight = Math.max(0, pooled.inflight - 1); });
  }

  /** Parse many files; concurrency cap is implicit in pool size. */
  async parseFiles(filePaths: readonly string[]): Promise<readonly ParseResult[]> {
    return Promise.all(filePaths.map((p) => this.parseFile(p)));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { worker } of this.workers) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
    this.workers.length = 0;
  }

  // -- internals -------------------------------------------------------------

  private spawn(): PooledWorker {
    const worker = new Worker(this.workerEntry!);

    worker.on('message', (msg: { id: number; ok: boolean; result?: ParseResult; error?: string }) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? 'Worker error'));
    });
    worker.on('error', (err: Error) => {
      this.logger.error({ error: err.message }, 'Worker error');
    });
    worker.on('exit', (code) => {
      if (this.closed) return;
      this.logger.warn({ code }, 'Worker exited unexpectedly — replacing');
      // Reject any pending requests assigned to no specific worker — they'll
      // retry against the in-process fallback on next call.
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Worker exited (code=${code})`));
        this.pending.delete(id);
      }
      const idx = this.workers.findIndex((w) => w.worker === worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      // Lazily respawn so the pool self-heals
      try {
        this.workers.push(this.spawn());
      } catch (e) {
        this.logger.error({ error: e instanceof Error ? e.message : String(e) }, 'Failed to respawn worker');
      }
    });

    return { worker, inflight: 0 };
  }

  /**
   * Locate the compiled worker JS. We only run workers from `dist/` because
   * Node can't `import` raw .ts. In dev/test (no dist), we fall back to
   * in-process parsing — same behaviour, just slower.
   */
  private locateWorkerEntry(): string | undefined {
    try {
      // import.meta.url gives the location of THIS source file at runtime.
      // After compile it'll be …/dist/typescript.parser.pool.js so the worker
      // sits next to it as typescript.parser.worker.js.
      const here = fileURLToPath(import.meta.url);
      const candidate = join(dirname(here), 'typescript.parser.worker.js');
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
    return undefined;
  }
}
