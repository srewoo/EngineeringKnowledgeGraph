/**
 * Graph node and relationship type definitions.
 *
 * These represent the core data model of the Engineering Knowledge Graph.
 * Nodes are entities (services, files, databases), relationships are edges
 * connecting them with semantic meaning.
 */

// -- Edge Confidence --

export type EdgeConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export const EDGE_CONFIDENCE_SCORES: Readonly<Record<EdgeConfidence, number>> = {
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.4,
} as const;

// -- Node Labels --

export type NodeLabel =
  | 'Service'
  | 'API'
  | 'Database'
  | 'Repo'
  | 'File'
  | 'Module'
  | 'Config'
  | 'MessageQueue'
  | 'Topic'
  | 'Feature'
  | 'TestCase'
  | 'Owner'
  | 'Team'
  | 'Doc'
  | 'Table'
  | 'Column'
  | 'Migration'
  | 'Function'
  | 'Class'
  | 'Method'
  | 'TypeDef'
  | 'Commit';

// -- Relationship Types --

export type RelationshipType =
  | 'IMPORTS'
  | 'EXPORTS'
  | 'USES'
  | 'CALLS'
  | 'EXPOSES'
  | 'CONTAINS'
  | 'DEPENDS_ON'
  | 'READS_CONFIG'
  | 'IMPLEMENTS'
  | 'TESTS'
  | 'OWNS'
  | 'MEMBER_OF'
  | 'DOCUMENTED_BY'
  | 'HAS'
  | 'ALTERS'
  | 'RELATES_TO'
  | 'DEFINES'
  | 'EXTENDS'
  | 'PRODUCES'
  | 'CONSUMES'
  | 'CALLS_API'
  | 'OWNED_BY'
  | 'TOUCHED';

// -- Base Node --

export interface GraphNode {
  readonly id: string;
  readonly label: NodeLabel;
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

// -- Specific Nodes --

export interface ServiceNode extends GraphNode {
  readonly label: 'Service';
  readonly properties: Readonly<{
    repoUrl: string;
    directory: string;
    detectionMethod: 'config' | 'package_json' | 'dockerfile' | 'fallback';
  }>;
}

export interface FileNode extends GraphNode {
  readonly label: 'File';
  readonly properties: Readonly<{
    path: string;
    language: string;
    hash: string;
    repoUrl: string;
  }>;
}

export interface ModuleNode extends GraphNode {
  readonly label: 'Module';
  readonly properties: Readonly<{
    packageName: string;
    isLocal: boolean;
  }>;
}

export interface DatabaseNode extends GraphNode {
  readonly label: 'Database';
  readonly properties: Readonly<{
    type: string;
    detectedVia: 'sdk_import' | 'config_file' | 'orm_detection';
  }>;
}

export type ApiSpecVersion = 'openapi-3' | 'swagger-2';

export interface ApiNode extends GraphNode {
  readonly label: 'API';
  readonly properties: Readonly<{
    method: string;
    path: string;
    framework: string;
    // -- OpenAPI / Swagger enrichment (Phase 1.5). All optional so existing
    // API nodes emitted by regex/AST extractors remain valid. --
    operationId?: string;
    summary?: string;
    description?: string;
    requestSchema?: unknown;
    responseSchemas?: Readonly<Record<string, unknown>>;
    tags?: readonly string[];
    specVersion?: ApiSpecVersion;
    specPath?: string;
  }>;
}

export interface RepoNode extends GraphNode {
  readonly label: 'Repo';
  readonly properties: Readonly<{
    url: string;
    branch: string;
    lastCommitSha: string;
  }>;
}

// -- Doc Nodes --

export type DocKind = 'README' | 'RUNBOOK' | 'ADR' | 'CHANGELOG' | 'PRD' | 'OTHER';

export interface DocHeading {
  readonly level: number;
  readonly text: string;
}

export interface CodeBlock {
  readonly language: string;
  readonly code: string;
  readonly startLine: number;
}

export interface DocLink {
  readonly text: string;
  readonly url: string;
}

export interface DocNode extends GraphNode {
  readonly label: 'Doc';
  readonly properties: Readonly<{
    path: string;
    repoUrl: string;
    kind: DocKind;
    title: string;
    headings: readonly DocHeading[];
    rawText: string;
    codeBlockCount: number;
    linkCount: number;
    format: 'markdown' | 'mdx' | 'rst' | 'adoc';
  }>;
}

// -- Kafka Topic Node (Phase 1.5 follow-ups) --

export interface TopicNode extends GraphNode {
  readonly label: 'Topic';
  readonly properties: Readonly<{
    name: string;
    /** When the literal contained `${var}` placeholders, the original template. */
    template?: string;
  }>;
}

// -- Schema Nodes (DB tables/columns/migrations) --

export interface TableNode extends GraphNode {
  readonly label: 'Table';
  readonly properties: Readonly<{
    name: string;
    schema?: string;
    repoUrl: string;
    filePath: string;
    sourceLine: number;
    raw?: string;
  }>;
}

export interface ColumnNode extends GraphNode {
  readonly label: 'Column';
  readonly properties: Readonly<{
    tableId: string;
    name: string;
    type: string;
    nullable: boolean;
    isPrimary: boolean;
    isUnique: boolean;
    isList?: boolean;
    defaultValue?: string;
    mappedName?: string;
  }>;
}

export interface MigrationNode extends GraphNode {
  readonly label: 'Migration';
  readonly properties: Readonly<{
    name: string;
    filePath: string;
    repoUrl: string;
    appliedAt?: string;
  }>;
}

// -- Symbol Nodes (function-level extraction, Phase 1.3) --

export type TypeDefKind = 'interface' | 'type-alias' | 'enum';
export type MethodVisibility = 'public' | 'private' | 'protected';

export interface FunctionNode extends GraphNode {
  readonly label: 'Function';
  readonly properties: Readonly<{
    name: string;
    repoUrl: string;
    filePath: string;
    language: string;
    signature: string;
    docComment?: string;
    lineStart: number;
    lineEnd: number;
    isExported: boolean;
    isAsync: boolean;
    complexity?: number;
    sourceLine: number;
  }>;
}

export interface ClassNode extends GraphNode {
  readonly label: 'Class';
  readonly properties: Readonly<{
    name: string;
    repoUrl: string;
    filePath: string;
    language: string;
    lineStart: number;
    lineEnd: number;
    isExported: boolean;
    isAbstract: boolean;
    docComment?: string;
    sourceLine: number;
  }>;
}

export interface MethodNode extends GraphNode {
  readonly label: 'Method';
  readonly properties: Readonly<{
    classId: string;
    name: string;
    signature: string;
    docComment?: string;
    lineStart: number;
    lineEnd: number;
    isStatic: boolean;
    isAsync: boolean;
    visibility: MethodVisibility;
    complexity?: number;
    sourceLine: number;
  }>;
}

export interface TypeDefNode extends GraphNode {
  readonly label: 'TypeDef';
  readonly properties: Readonly<{
    name: string;
    kind: TypeDefKind;
    repoUrl: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    isExported: boolean;
    sourceLine: number;
  }>;
}

// -- Ownership Nodes (Phase 1.7) --

export type OwnerKind = 'user' | 'team' | 'email';

export interface OwnerNode extends GraphNode {
  readonly label: 'Owner';
  readonly properties: Readonly<{
    identifier: string;
    kind: OwnerKind;
    repoUrl: string;
  }>;
}

export interface TeamNode extends GraphNode {
  readonly label: 'Team';
  readonly properties: Readonly<{
    name: string;
    repoUrl: string;
  }>;
}

// -- Commit Node (Phase 1.7) --

export interface CommitNode extends GraphNode {
  readonly label: 'Commit';
  readonly properties: Readonly<{
    sha: string;
    repoUrl: string;
    author: string;
    authorEmail: string;
    message: string;
    authoredAt: string;
    parentShas: readonly string[];
  }>;
}

// -- Relationship --

export interface GraphRelationship {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence: EdgeConfidence;
  readonly properties: Readonly<Record<string, unknown>>;
}

// -- Extraction Result --

/**
 * HTTP call site captured during extraction, retained on the result so the
 * downstream URL→API resolver (Phase 1.5) can run after all APIs are known.
 */
export interface ExtractedHttpCallSite {
  readonly url: string;
  readonly method: string;
  readonly clientLibrary: string;
  readonly sourceLine: number;
  readonly filePath: string;
  readonly callerSymbolId?: string;
  readonly isTemplate: boolean;
}

export interface ExtractionResult {
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
  readonly sourceFile: string;
  readonly repoUrl: string;
  /** Phase 1.5 — populated for URL→API resolver. Empty when no HTTP calls. */
  readonly httpCallSites?: readonly ExtractedHttpCallSite[];
}
