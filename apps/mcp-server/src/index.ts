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
import { SqliteRepository } from '@ekg/storage';
import { IngestionService, BulkIngestionService, ServiceResolver } from '@ekg/worker';
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
  const ingestionService = new IngestionService(env.dataDir, neo4jClient, sqliteRepo);
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

  const server = createMcpServer({
    neo4jClient,
    graphQueries,
    sqliteRepo,
    ingestionService,
    bulkService,
    serviceResolver,
    gitlabConfig: {
      gitlabUrl: env.gitlabUrl,
      token: env.gitToken ?? '',
      maxRepoSizeMb: env.maxRepoSizeMb,
      concurrency: env.bulkConcurrency,
    },
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
