#!/usr/bin/env node

/**
 * EKG MCP Server — entry point.
 *
 * Initialises all dependencies, connects to Neo4j and SQLite,
 * creates the MCP server, and starts the stdio transport.
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve .env from monorepo root (regardless of CWD)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: envPath });

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger, initFileLogging, envConfigSchema } from '@ekg/shared';
import { Neo4jClient, GraphQueries } from '@ekg/graph';
import { SqliteRepository, UnresolvedHttpRepository } from '@ekg/storage';
import { IngestionService, BulkIngestionService, ServiceResolver, EmbeddingsService, SearchIndexService } from '@ekg/worker';
import { bootstrapAdapters } from '@ekg/adapters';
import { createMcpServer } from './server.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// Each Pino dual-transport logger adds an exit listener — increase limit
process.setMaxListeners(30);

const logger = createLogger({ service: 'ekg' });

async function main(): Promise<void> {
  logger.info('Starting EKG MCP Server');

  // Load and validate environment config
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

  // Ensure data directory exists and init file logging
  mkdirSync(env.dataDir, { recursive: true });
  initFileLogging(env.dataDir);

  // Re-create logger with file transport active
  const log = createLogger({ service: 'ekg', level: env.logLevel });
  log.info({ dataDir: env.dataDir, logFile: `${env.dataDir}/ekg.log` }, 'File logging enabled');

  // Initialise Neo4j client
  const neo4jClient = new Neo4jClient({
    uri: env.neo4jUri,
    user: env.neo4jUser,
    password: env.neo4jPassword,
  });

  try {
    await neo4jClient.verifyConnectivity();
  } catch {
    logger.warn('Neo4j not available — graph queries will fail until connected');
  }

  // Initialise SQLite
  const dbPath = join(env.dataDir, 'ekg.db');
  logger.info({ dbPath }, 'Initialising SQLite');
  const sqliteRepo = new SqliteRepository(dbPath);

  // Initialise services
  const graphQueries = new GraphQueries(neo4jClient);

  // Embeddings — opt-in via EKG_EMBEDDINGS_ENABLED=true. Stored in a sibling
  // SQLite file so the main metadata DB stays small and a wiped embeddings
  // store does not affect ingestion bookkeeping.
  const embeddingsEnabled = (process.env['EKG_EMBEDDINGS_ENABLED'] ?? 'false').toLowerCase() === 'true';
  const embeddingsService = new EmbeddingsService({
    enabled: embeddingsEnabled,
    dbPath: join(env.dataDir, 'ekg-embeddings.db'),
  });
  if (embeddingsEnabled) {
    logger.info('Embeddings enabled (EKG_EMBEDDINGS_ENABLED=true)');
  }

  // BM25 / FTS5 — always-on, local + free. Stored in a sibling SQLite file
  // so heavy text indexing does not bloat the metadata DB.
  const searchIndexDbPath = join(env.dataDir, 'ekg-search.db');
  const searchIndexService = new SearchIndexService({ dbPath: searchIndexDbPath });
  const searchTextRepo = searchIndexService.getRepository();
  logger.info({ searchIndexDbPath }, 'BM25 search index initialised');

  const unresolvedHttpRepo = new UnresolvedHttpRepository(sqliteRepo.getConnection());
  const ingestionService = new IngestionService(env.dataDir, neo4jClient, sqliteRepo, embeddingsService, searchIndexService, unresolvedHttpRepo);
  const bulkService = new BulkIngestionService(ingestionService, sqliteRepo, env.ingestTimeoutMs);
  const serviceResolver = new ServiceResolver(neo4jClient);

  // Initialise graph indexes
  try {
    await ingestionService.initGraph();
    logger.info('Graph indexes initialised');
  } catch {
    logger.warn('Could not initialise graph indexes — Neo4j may not be running');
  }

  // Resume any bulk jobs left mid-ingestion by a previous restart.
  if (env.gitToken) {
    try {
      bulkService.resumeInterrupted(env.gitToken);
    } catch (e) {
      logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Failed to resume interrupted bulk jobs');
    }
  }

  // Create and start MCP server
  logger.info({
    maxRepoSizeMb: env.maxRepoSizeMb,
    bulkConcurrency: env.bulkConcurrency,
    gitlabUrl: env.gitlabUrl,
  }, 'Creating MCP server');

  // Phase 6 — bootstrap external MCP adapters from ekg.config.json. The
  // monorepo root is two levels above this file's package directory.
  const repoRoot = resolve(__dirname, '..', '..', '..');
  let adapterRegistry: import('@ekg/adapters').AdapterRegistry | undefined;
  let runtimeRegistry: import('@ekg/advanced').RuntimeProviderRegistry | undefined;
  try {
    const result = await bootstrapAdapters({ configPath: repoRoot });
    adapterRegistry = result.registry;
    runtimeRegistry = result.runtimeRegistry;
    log.info({ count: result.registry.size() }, 'External MCP adapters bootstrapped');
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'adapter bootstrap failed');
  }

  const server = createMcpServer({
    neo4jClient,
    graphQueries,
    sqliteRepo,
    ingestionService,
    bulkService,
    serviceResolver,
    embeddingsService,
    searchTextRepo,
    ...(adapterRegistry ? { adapterRegistry } : {}),
    ...(runtimeRegistry ? { runtimeRegistry } : {}),
    gitlabConfig: {
      gitlabUrl: env.gitlabUrl,
      token: env.gitToken ?? '',
      maxRepoSizeMb: env.maxRepoSizeMb,
      concurrency: env.bulkConcurrency,
    },
    dataDir: env.dataDir,
  });

  logger.info('Connecting stdio transport');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('EKG MCP Server running on stdio');

  // Graceful shutdown — drain in-flight bulk jobs before closing connections.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down — draining bulk ingestion');
    try {
      await bulkService.shutdown(30_000);
    } catch (e) {
      logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Bulk drain failed');
    }
    try { await ingestionService.close(); } catch { /* ignore */ }
    try { embeddingsService.close(); } catch { /* ignore */ }
    try { searchIndexService.close(); } catch { /* ignore */ }
    try { sqliteRepo.close(); } catch { /* ignore */ }
    try { await neo4jClient.close(); } catch { /* ignore */ }
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error({ errorMessage: message, stack }, 'Fatal error starting MCP server');
  console.error('Fatal error:', message);
  if (stack) console.error(stack);
  process.exit(1);
});
