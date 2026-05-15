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
 * Symbol-level extraction (Phase 1.3) — function/class/method/typedef and
 * the edges between them. Carried on ParseResult so it flows through the
 * worker-thread pool unchanged.
 *
 * Cross-file/cross-module callee resolution is deferred — unresolved targets
 * use a `name@modulePath` reference id with confidence MEDIUM.
 */
export interface ParsedFunction {
  readonly id: string;
  readonly name: string;
  readonly signature: string;
  readonly docComment?: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly complexity: number;
}

export interface ParsedClass {
  readonly id: string;
  readonly name: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
  readonly isAbstract: boolean;
  readonly docComment?: string;
  /** Reference id (`name@modulePath` or local class id) for the extended class, if any. */
  readonly extendsRef?: string;
}

export interface ParsedMethod {
  readonly id: string;
  readonly classId: string;
  readonly name: string;
  readonly signature: string;
  readonly docComment?: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isStatic: boolean;
  readonly isAsync: boolean;
  readonly visibility: 'public' | 'private' | 'protected';
  readonly complexity: number;
}

export interface ParsedTypeDef {
  readonly id: string;
  readonly name: string;
  readonly kind: 'interface' | 'type-alias' | 'enum';
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
}

/**
 * A call edge from a function or method to another callable.
 * `targetId` is either a real id (same-file resolved) or a `name@modulePath`
 * reference (unresolved import — MEDIUM confidence).
 */
export interface ParsedCall {
  readonly sourceId: string;
  readonly targetId: string;
  readonly resolved: boolean;
}

export interface ParsedTypeUse {
  readonly sourceId: string;
  readonly targetId: string;
  readonly resolved: boolean;
}

export interface ParsedSymbols {
  readonly functions: readonly ParsedFunction[];
  readonly classes: readonly ParsedClass[];
  readonly methods: readonly ParsedMethod[];
  readonly typeDefs: readonly ParsedTypeDef[];
  readonly calls: readonly ParsedCall[];
  readonly typeUses: readonly ParsedTypeUse[];
}

/**
 * Kafka topic literal extracted from a producer or consumer call site
 * (Phase 1.5 follow-ups).
 *
 * `template` carries the original template-literal form (with `${var}`
 * placeholders) when the literal isn't a plain string. `name` is what
 * we use as the topic node id.
 */
export interface ParsedKafkaTopicRef {
  readonly name: string;
  readonly template?: string;
  readonly sourceLine: number;
  readonly confidence: 'HIGH' | 'MEDIUM';
  readonly clientLibrary?: string;
}

export interface ParsedKafka {
  readonly producers: readonly ParsedKafkaTopicRef[];
  readonly consumers: readonly ParsedKafkaTopicRef[];
}

/**
 * Rich HTTP call site extracted for cross-service URL→API linking.
 * Carries the source line and an optional caller symbol id (function/method)
 * so the resolver can emit `Function -[CALLS_API]-> API` edges.
 */
export interface ParsedHttpCallSite {
  readonly url: string;
  readonly method: string;
  readonly clientLibrary: string;
  readonly sourceLine: number;
  readonly callerSymbolId?: string;
  /** True when the URL was a template literal containing `${var}` placeholders. */
  readonly isTemplate: boolean;
}

/**
 * Source-side env-var read site (Phase 1.6 follow-ups).
 *
 * Captured by both the TS/JS AST parser and the multi-language regex
 * tables. The downstream `EnvReadResolver` matches `key` against
 * `ConfigKey.key` to emit `Function|Method -[READS_CONFIG]-> ConfigKey`
 * edges.
 *
 *   - `key`               : the env-var name (e.g. `DATABASE_URL`).
 *   - `callerSymbolId`    : enclosing function/method symbol id, when known.
 *   - `sourceLine`        : 1-based line of the read site.
 *   - `confidence`        : HIGH for literal access, MEDIUM for resolved
 *                           same-file const indirection.
 *   - `kind`              : `'env'` for `process.env` / `os.getenv` style
 *                           reads; `'system-property'` for Java
 *                           `System.getProperty(...)`.
 */
export interface ParsedEnvRead {
  readonly key: string;
  readonly callerSymbolId?: string;
  readonly sourceLine: number;
  readonly confidence: 'HIGH' | 'MEDIUM';
  readonly kind: 'env' | 'system-property';
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
  /** Symbol-level extraction (Phase 1.3). Only populated for TS/JS today. */
  readonly symbols?: ParsedSymbols;
  /** Kafka producer/consumer topic literals (Phase 1.5 follow-ups). */
  readonly kafka?: ParsedKafka;
  /** Rich HTTP call sites for cross-service URL→API resolution (Phase 1.5 follow-ups). */
  readonly httpCallSites?: readonly ParsedHttpCallSite[];
  /** Env-var read sites captured at source-code level (Phase 1.6 follow-ups). */
  readonly parsedEnvReads?: readonly ParsedEnvRead[];
}
