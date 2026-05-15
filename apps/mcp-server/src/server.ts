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
import { SqliteRepository, SnapshotRepository, DlqRepository, UnresolvedHttpRepository, AgentSessionRepository } from '@ekg/storage';
import { RuntimeProviderRegistry } from '@ekg/advanced';
import { AdapterRegistry, CapabilityRouter } from '@ekg/adapters';
import { IngestionService, BulkIngestionService, ServiceResolver } from '@ekg/worker';
import type { EmbeddingsService } from '@ekg/worker';
import type { SearchTextRepository } from '@ekg/storage';
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
import { registerSearchSemanticTool } from './tools/search-semantic.tool.js';
import { registerAskQuestionTool } from './tools/ask-question.tool.js';
import { registerAnswerQuestionTool } from './tools/answer-question.tool.js';
import { registerStartSessionTool } from './tools/start-session.tool.js';
import { registerEndSessionTool } from './tools/end-session.tool.js';
import { registerDataFreshnessTool } from './tools/data-freshness.tool.js';
import { registerIngestOnPushTool } from './tools/ingest-on-push.tool.js';
import { registerSubmitFeedbackTool } from './tools/submit-feedback.tool.js';
import { registerEvalRunTool } from './tools/eval-run.tool.js';
// Phase 5 — advanced graph operations.
import { registerSynthesizeFlowTool } from './tools/synthesize-flow.tool.js';
import { registerAnalyzeImpactV2Tool } from './tools/analyze-impact-v2.tool.js';
import { registerSnapshotGraphTool, registerDiffSnapshotsTool } from './tools/snapshot.tools.js';
import { registerRuntimeEvidenceTool } from './tools/runtime-evidence.tool.js';
import { registerListAdaptersTool } from './tools/list-adapters.tool.js';
import { registerAdapterQueryTool } from './tools/adapter-query.tool.js';
// Phase 1.1 — DLQ surface for bulk-ingestion reliability.
import { registerListDlqTool } from './tools/list-dlq.tool.js';
import { registerListUnresolvedHttpCallsTool } from './tools/list-unresolved-http-calls.tool.js';
import { registerRetryDlqTool } from './tools/retry-dlq.tool.js';

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
  readonly embeddingsService?: EmbeddingsService;
  readonly searchTextRepo?: SearchTextRepository;
  readonly runtimeRegistry?: RuntimeProviderRegistry;
  readonly adapterRegistry?: AdapterRegistry;
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
  if (deps.searchTextRepo) {
    registerSearchCodebaseTool(server, {
      searchText: deps.searchTextRepo,
      ...(deps.embeddingsService ? { embeddingsService: deps.embeddingsService } : {}),
      neo4jClient: deps.neo4jClient,
    });
  } else {
    logger.warn('search_codebase tool not registered: searchTextRepo missing');
  }
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
  registerSearchSemanticTool(server, deps.embeddingsService);
  if (deps.searchTextRepo) {
    registerAskQuestionTool(server, {
      searchText: deps.searchTextRepo,
      ...(deps.embeddingsService ? { embeddingsService: deps.embeddingsService } : {}),
      neo4jClient: deps.neo4jClient,
    });
    const agentSessionRepo = new AgentSessionRepository(deps.sqliteRepo.getConnection());
    registerAnswerQuestionTool(server, {
      searchText: deps.searchTextRepo,
      ...(deps.embeddingsService ? { embeddingsService: deps.embeddingsService } : {}),
      neo4jClient: deps.neo4jClient,
      sessions: agentSessionRepo,
    });
    registerStartSessionTool(server, agentSessionRepo);
    registerEndSessionTool(server, agentSessionRepo);
  } else {
    logger.warn('ask_question / answer_question tools not registered: searchTextRepo missing');
  }

  // Phase 4 — observability, freshness, feedback, eval.
  registerDataFreshnessTool(server, deps.sqliteRepo);
  registerIngestOnPushTool(server, {
    ingestionService: deps.ingestionService,
    token: deps.gitlabConfig.token,
  });
  registerSubmitFeedbackTool(server, deps.sqliteRepo);
  registerEvalRunTool(server);

  // Phase 5 — advanced graph operations.
  const snapshotRepo = new SnapshotRepository(deps.sqliteRepo.getConnection());
  const runtimeRegistry = deps.runtimeRegistry ?? new RuntimeProviderRegistry();
  registerSynthesizeFlowTool(server, deps.neo4jClient);
  registerAnalyzeImpactV2Tool(server, deps.neo4jClient);
  registerSnapshotGraphTool(server, deps.neo4jClient, snapshotRepo);
  registerDiffSnapshotsTool(server, snapshotRepo);
  registerRuntimeEvidenceTool(server, runtimeRegistry);

  // Phase 6 — external MCP adapter framework.
  const adapterRegistry = deps.adapterRegistry ?? new AdapterRegistry();
  const capabilityRouter = new CapabilityRouter(adapterRegistry);
  registerListAdaptersTool(server, adapterRegistry);
  registerAdapterQueryTool(server, capabilityRouter);

  // Phase 1.1 — DLQ surface for bulk-ingestion reliability.
  const dlqRepo = new DlqRepository(deps.sqliteRepo.getConnection());
  registerListDlqTool(server, dlqRepo);
  registerRetryDlqTool(server, {
    bulkService: deps.bulkService,
    dlq: dlqRepo,
    token: deps.gitlabConfig.token,
    defaultConcurrency: deps.gitlabConfig.concurrency,
  });

  // Phase 1.5 — surface unresolved cross-service HTTP calls.
  const unresolvedHttpRepo = new UnresolvedHttpRepository(deps.sqliteRepo.getConnection());
  registerListUnresolvedHttpCallsTool(server, unresolvedHttpRepo);

  // Register resources (4 total)
  registerGraphStatsResource(server, deps.neo4jClient, deps.sqliteRepo);
  registerMetricsResource(server, deps.neo4jClient);
  registerServiceListResource(server, deps.graphQueries);
  registerDatabaseListResource(server, deps.graphQueries);

  // Register prompts (2 total)
  registerPrompts(server);

  logger.info('MCP server configured: 33 tools, 4 resources, 2 prompts');

  return server;
}
