/**
 * Ingestion pipeline types — job tracking and status.
 */

export type IngestionStatus =
  | 'PENDING'
  | 'CLONING'
  | 'PARSING'
  | 'BUILDING_GRAPH'
  | 'COMPLETED'
  | 'FAILED';

export interface IngestionJob {
  readonly id: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly status: IngestionStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly commitSha?: string;
  readonly filesProcessed: number;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
  readonly error?: string;
}

export interface FileMetadata {
  readonly path: string;
  readonly repoUrl: string;
  readonly hash: string;
  readonly language: string;
  readonly lastParsedAt: string;
}

/**
 * Parsed import statement from AST analysis.
 */
export interface ParsedImport {
  readonly source: string;
  readonly specifiers: readonly string[];
  readonly isTypeOnly: boolean;
  readonly isLocal: boolean;
}

/**
 * Parsed export statement from AST analysis.
 */
export interface ParsedExport {
  readonly name: string;
  readonly kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'default';
  readonly isTypeOnly: boolean;
}

/**
 * Parsed API route from framework detection.
 */
export interface ParsedRoute {
  readonly method: string;
  readonly path: string;
  readonly handlerName: string;
  readonly framework: string;
}

/**
 * Parsed HTTP call to another service.
 */
export interface ParsedHttpCall {
  readonly url: string;
  readonly method: string;
  readonly clientLibrary: string;
}

/**
 * Parsed database usage detection.
 */
export interface ParsedDatabaseUsage {
  readonly databaseType: string;
  readonly detectedVia: 'sdk_import' | 'config_file' | 'orm_detection';
  readonly packageName: string;
}

/**
 * Complete parse result for a single file.
 */
export interface ParseResult {
  readonly filePath: string;
  readonly imports: readonly ParsedImport[];
  readonly exports: readonly ParsedExport[];
  readonly routes: readonly ParsedRoute[];
  readonly httpCalls: readonly ParsedHttpCall[];
  readonly databaseUsages: readonly ParsedDatabaseUsage[];
  readonly envVars: readonly string[];
  /** Lines of code in the parsed file (cheap newline count). */
  readonly loc?: number;
}
