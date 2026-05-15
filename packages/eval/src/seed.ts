#!/usr/bin/env node
/**
 * Synthetic seed for the CI eval gate.
 *
 * Writes a small set of search-text rows whose `nodeId` matches the
 * `goldCitations` in `eval-set/cases.json`. The retrieval-only eval agent
 * looks them up via BM25 — no Neo4j, no embeddings, no network. Fast,
 * deterministic, and good enough to exercise the citation-overlap gate.
 *
 * Reads `DATA_DIR` (default `./data`) and writes to `<DATA_DIR>/ekg-search.db`,
 * the same path the production search index uses.
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import { SearchTextRepository } from '@ekg/storage';

const seedRowSchema = z.object({
  nodeId: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1),
  path: z.string(),
  body: z.string(),
});

const seedFileSchema = z.array(seedRowSchema);

function defaultSeedPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval-set', 'seed.json');
}

function main(): void {
  const logger = createLogger({ service: 'ekg-eval-seed' });
  const dataDir = resolve(process.env['DATA_DIR'] ?? join(process.cwd(), 'data'));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'ekg-search.db');

  const seedPath = process.argv[2] ?? defaultSeedPath();
  const raw = readFileSync(seedPath, 'utf8');
  const rows = seedFileSchema.parse(JSON.parse(raw));

  const repo = new SearchTextRepository(dbPath);
  try {
    repo.index(rows.map((r) => ({
      label: r.label,
      nodeId: r.nodeId,
      repoUrl: 'seed://eval',
      name: r.name,
      path: r.path,
      body: r.body,
    })));
    logger.info({ dbPath, seedPath, count: rows.length }, 'seed indexed');
    process.stdout.write(`seeded ${rows.length} rows into ${dbPath}\n`);
  } finally {
    repo.close();
  }
}

try { main(); }
catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`seed failed: ${msg}\n`);
  process.exit(1);
}
