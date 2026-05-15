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
export type { BulkIngestionProgress } from './bulk.ingestion.js';
export { ServiceResolver } from './service.resolver.js';
export { EmbeddingsService } from './embeddings.service.js';
export type { EmbeddingsServiceOptions } from './embeddings.service.js';
export { SearchIndexService } from './search-index.service.js';
export type { SearchIndexServiceOptions } from './search-index.service.js';
