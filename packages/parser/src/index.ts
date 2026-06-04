export { TypeScriptParser } from './typescript.parser.js';
export { TypeScriptSymbolsParser } from './typescript.symbols.parser.js';
export { KafkaTypeScriptExtractor } from './kafka.ts.parser.js';
export { HttpClientTypeScriptExtractor } from './http.client.ts.parser.js';
export { TypeScriptParserPool } from './typescript.parser.pool.js';
export type { PoolOptions } from './typescript.parser.pool.js';
export { MultiLanguageParser } from './multi.language.parser.js';
export type { SupportedLanguage } from './multi.language.parser.js';
export { MultiLangSymbolsParser } from './multi.lang.symbols.parser.js';
export type { SupportedSymbolsLanguage } from './multi.lang.symbols.parser.js';
export { KafkaMultiLangExtractor } from './kafka.multi.parser.js';
export type { KafkaMultiLang } from './kafka.multi.parser.js';
export { FileScanner } from './file.scanner.js';
export type { ScanOptions, ScannedFile } from './file.scanner.js';
export { MetadataScanner } from './metadata.scanner.js';
export type { RepoMetadata, CodeOwnerRule } from './metadata.scanner.js';
export { ApiSchemaScanner } from './api.schema.scanner.js';
export type { ApiSchemaScanResult } from './api.schema.scanner.js';
export { ConfigScanner } from './config.scanner.js';
export type { ConfigScanResult, EnvVarDefinition } from './config.scanner.js';
export { GitLabClient } from './gitlab.client.js';
export type { GitLabRepo, GitLabDiscoveryOptions } from './gitlab.client.js';
export { GitHubClient } from './github.client.js';
export type { GitHubDiscoveryOptions } from './github.client.js';
export {
  GitLogParser,
  parseGitLogOutput,
  DEFAULT_MAX_COMMITS,
  DEFAULT_SINCE,
} from './git.log.parser.js';
export type {
  ParsedCommit,
  GitLogResult,
  GitLogOptions,
  GitFactory,
} from './git.log.parser.js';

// Phase A — tree-sitter parsers (ADR-007). Optional runtime deps; each
// self-disables if its grammar isn't installed, with the regex parser as
// the documented fallback.
export {
  TreeSitterPythonParser,
  parseFromTree as parsePythonFromTree,
  isTreeSitterPythonEnabled,
} from './tree-sitter/python.parser.js';
export type {
  PythonParseInputs,
  SyntaxNodeLike,
  TreeLike,
} from './tree-sitter/python.parser.js';
export {
  TreeSitterGoParser,
  parseFromTree as parseGoFromTree,
  isTreeSitterGoEnabled,
} from './tree-sitter/go.parser.js';
export type { GoParseInputs } from './tree-sitter/go.parser.js';
export {
  TreeSitterJavaParser,
  parseFromTree as parseJavaFromTree,
  isTreeSitterJavaEnabled,
} from './tree-sitter/java.parser.js';
export type { JavaParseInputs } from './tree-sitter/java.parser.js';
