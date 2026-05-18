#!/usr/bin/env node

/**
 * EKG Webhook Server — entry point.
 *
 * Receives GitLab push events and enqueues incremental ingests through the
 * shared IngestionService. Runs as a separate process from the MCP server;
 * both share `data/ekg.db` and the same Neo4j instance.
 */

import dotenv from 'dotenv';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { z } from 'zod';
import { createLogger, initFileLogging, envConfigSchema } from '@ekg/shared';
import { Neo4jClient } from '@ekg/graph';
import { SqliteRepository, UnresolvedHttpRepository } from '@ekg/storage';
import {
  IngestionService,
  EmbeddingsService,
  SearchIndexService,
} from '@ekg/worker';
import { createWebhookServer } from './server.js';
import { IngestQueue, type IngestJobRequest } from './queue.js';
import { parseAllowList } from './schema.js';

const webhookEnvSchema = z.object({
  port: z.coerce.number().int().positive().default(8765),
  secret: z.string().min(1, 'EKG_WEBHOOK_SECRET is required'),
  allowListRaw: z.string().optional(),
  maxConcurrent: z.coerce.number().int().positive().default(5),
});

async function main(): Promise<void> {
  const logger = createLogger({ service: 'ekg-webhook' });
  logger.info('Starting EKG Webhook Server');

  const env = envConfigSchema.parse({
    neo4jUri: process.env['NEO4J_URI'],
    neo4jUser: process.env['NEO4J_USER'],
    neo4jPassword: process.env['NEO4J_PASSWORD'],
    gitToken: process.env['GIT_TOKEN'],
    logLevel: process.env['LOG_LEVEL'],
    dataDir: process.env['DATA_DIR'],
    gitlabUrl: process.env['GITLAB_URL'],
    gitlabGroupIds: process.env['GITLAB_GROUP_IDS'],
    maxRepoSizeMb: process.env['MAX_REPO_SIZE_MB'],
    bulkConcurrency: process.env['BULK_CONCURRENCY'],
    ingestTimeoutMs: process.env['INGEST_TIMEOUT_MS'],
  });

  const webhookEnv = webhookEnvSchema.parse({
    port: process.env['EKG_WEBHOOK_PORT'],
    secret: process.env['EKG_WEBHOOK_SECRET'],
    allowListRaw: process.env['EKG_WEBHOOK_REPO_PATTERNS'],
    maxConcurrent: process.env['EKG_WEBHOOK_MAX_CONCURRENT'],
  });

  const allowList = parseAllowList(webhookEnv.allowListRaw);

  mkdirSync(env.dataDir, { recursive: true });
  initFileLogging(env.dataDir);
  const log = createLogger({ service: 'ekg-webhook', level: env.logLevel });

  // Connect Neo4j (same instance as MCP server).
  const neo4jClient = new Neo4jClient({
    uri: env.neo4jUri,
    user: env.neo4jUser,
    password: env.neo4jPassword,
  });
  try {
    await neo4jClient.verifyConnectivity();
  } catch {
    log.warn('Neo4j not available — webhooks will fail until connected');
  }

  // SQLite + sibling stores (same paths as MCP server so both processes
  // operate on the same on-disk graph metadata).
  const sqliteRepo = new SqliteRepository(join(env.dataDir, 'ekg.db'));
  const embeddingsService = new EmbeddingsService({
    enabled:
      (process.env['EKG_EMBEDDINGS_ENABLED'] ?? 'false').toLowerCase() === 'true',
    dbPath: join(env.dataDir, 'ekg-embeddings.db'),
  });
  const searchIndexService = new SearchIndexService({
    dbPath: join(env.dataDir, 'ekg-search.db'),
  });
  const unresolvedHttpRepo = new UnresolvedHttpRepository(sqliteRepo.getConnection());
  const ingestionService = new IngestionService(
    env.dataDir,
    neo4jClient,
    sqliteRepo,
    embeddingsService,
    searchIndexService,
    unresolvedHttpRepo,
  );
  try {
    await ingestionService.initGraph();
  } catch {
    log.warn('Could not initialise graph indexes — Neo4j may not be running');
  }

  const queue = new IngestQueue({
    maxConcurrent: webhookEnv.maxConcurrent,
    runner: async (req: IngestJobRequest): Promise<void> => {
      await ingestionService.ingest({
        repoUrl: req.repoUrl,
        branch: req.branch,
        ...(req.token ? { token: req.token } : {}),
      });
    },
    logger: log,
  });

  const server = createWebhookServer({
    port: webhookEnv.port,
    secret: webhookEnv.secret,
    allowList,
    queue,
    logger: log,
    ...(env.gitToken ? { token: env.gitToken } : {}),
  });

  await new Promise<void>((res) => {
    server.listen(webhookEnv.port, () => res());
  });
  log.info(
    {
      port: webhookEnv.port,
      allowListSize: allowList.length,
      maxConcurrent: webhookEnv.maxConcurrent,
    },
    'webhook server listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'webhook shutting down — draining queue');
    server.close();
    try {
      await queue.drain();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'queue drain failed',
      );
    }
    try { await ingestionService.close(); } catch { /* ignore */ }
    try { embeddingsService.close(); } catch { /* ignore */ }
    try { searchIndexService.close(); } catch { /* ignore */ }
    try { sqliteRepo.close(); } catch { /* ignore */ }
    try { await neo4jClient.close(); } catch { /* ignore */ }
    log.info('webhook shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  process.stderr.write(`Fatal error starting webhook server: ${message}\n`);
  if (stack) process.stderr.write(`${stack}\n`);
  process.exit(1);
});
