/**
 * MCP server setup — registers tools, resources, prompts, and starts transport.
 *
 * Uses stdio transport (standard for local MCP servers).
 * All tool inputs are validated with Zod schemas before processing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '@ekg/shared';
import { Neo4jClient } from '@ekg/graph';
import { GraphQueries } from '@ekg/graph';
import { SqliteRepository } from '@ekg/storage';
import { IngestionService, BulkIngestionService, ServiceResolver } from '@ekg/worker';
import type { Logger } from '@ekg/shared';

// Tools
import { registerIngestRepoTool } from './tools/ingest-repo.tool.js';
import { registerListServicesTool } from './tools/list-services.tool.js';
import { registerListDatabasesTool } from './tools/list-databases.tool.js';
import { registerSearchCodebaseTool } from './tools/search-codebase.tool.js';
import { registerGetDependenciesTool } from './tools/get-dependencies.tool.js';
import { registerAnalyzeImpactTool } from './tools/analyze-impact.tool.js';
import { registerGetServiceSummaryTool } from './tools/get-service-summary.tool.js';
import { registerGetApiMapTool } from './tools/get-api-map.tool.js';
import { registerGetIngestionStatusTool } from './tools/get-ingestion-status.tool.js';
import { registerDiscoverReposTool } from './tools/discover-repos.tool.js';
import { registerBulkIngestTool } from './tools/bulk-ingest.tool.js';
import { registerResolveServicesTool } from './tools/resolve-services.tool.js';
import { registerRetryFailedTool } from './tools/retry-failed.tool.js';
import { registerCypherQueryTool } from './tools/cypher-query.tool.js';
import { registerGetMetricsTool } from './tools/get-metrics.tool.js';

// Resources
import { registerGraphStatsResource } from './resources/graph-stats.resource.js';
import { registerMetricsResource } from './resources/metrics.resource.js';
import { registerServiceListResource, registerDatabaseListResource } from './resources/list.resources.js';

// Prompts
import { registerPrompts } from './prompts/report.prompts.js';

export interface ServerDependencies {
  readonly neo4jClient: Neo4jClient;
  readonly graphQueries: GraphQueries;
  readonly sqliteRepo: SqliteRepository;
  readonly ingestionService: IngestionService;
  readonly bulkService: BulkIngestionService;
  readonly serviceResolver: ServiceResolver;
  readonly gitlabConfig: {
    readonly gitlabUrl: string;
    readonly token: string;
    readonly maxRepoSizeMb: number;
    readonly concurrency: number;
  };
}

export function createMcpServer(deps: ServerDependencies): McpServer {
  const logger: Logger = createLogger({ service: 'mcp-server' });

  const server = new McpServer({
    name: 'ekg-mcp-server',
    version: '0.1.0',
  });

  logger.info('Registering MCP tools, resources, and prompts');

  // Register tools (12 total)
  registerIngestRepoTool(server, deps.ingestionService);
  registerListServicesTool(server, deps.graphQueries);
  registerListDatabasesTool(server, deps.graphQueries);
  registerSearchCodebaseTool(server, deps.graphQueries);
  registerGetDependenciesTool(server, deps.graphQueries);
  registerAnalyzeImpactTool(server, deps.graphQueries);
  registerGetServiceSummaryTool(server, deps.graphQueries);
  registerGetApiMapTool(server, deps.graphQueries);
  registerGetIngestionStatusTool(server, deps.sqliteRepo, deps.bulkService);
  registerDiscoverReposTool(server, {
    gitlabUrl: deps.gitlabConfig.gitlabUrl,
    token: deps.gitlabConfig.token,
    maxRepoSizeMb: deps.gitlabConfig.maxRepoSizeMb,
  });
  registerBulkIngestTool(server, deps.bulkService, deps.gitlabConfig);
  registerResolveServicesTool(server, deps.serviceResolver);
  registerRetryFailedTool(server, deps.sqliteRepo, deps.ingestionService, deps.gitlabConfig.token);
  registerCypherQueryTool(server, deps.neo4jClient);
  registerGetMetricsTool(server, deps.neo4jClient);

  // Register resources (4 total)
  registerGraphStatsResource(server, deps.neo4jClient, deps.sqliteRepo);
  registerMetricsResource(server, deps.neo4jClient);
  registerServiceListResource(server, deps.graphQueries);
  registerDatabaseListResource(server, deps.graphQueries);

  // Register prompts (2 total)
  registerPrompts(server);

  logger.info('MCP server configured: 15 tools, 4 resources, 2 prompts');

  return server;
}
