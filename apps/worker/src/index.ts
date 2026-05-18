/**
 * Worker entry point.
 *
 * Can be invoked directly for CLI usage or imported
 * programmatically by the MCP server.
 */

export { RepoCloner } from './repo.cloner.js';
export type { CloneResult } from './repo.cloner.js';
export { IngestionService } from './ingestion.service.js';
export type { IngestionOptions } from './ingestion.service.js';
export { BulkIngestionService } from './bulk.ingestion.js';
export type { BulkIngestionProgress, BulkRetryConfig } from './bulk.ingestion.js';
export { DEFAULT_BULK_RETRY, computeBackoffMs } from './bulk.retry.js';
export { ServiceResolver } from './service.resolver.js';
export { EmbeddingsService } from './embeddings.service.js';
export type { EmbeddingsServiceOptions } from './embeddings.service.js';
export { SearchIndexService } from './search-index.service.js';
export type { SearchIndexServiceOptions } from './search-index.service.js';
export { SchemaDriftDetector } from './schema.drift.js';
export type { DriftSignal } from './schema.drift.js';
