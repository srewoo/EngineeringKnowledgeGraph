/**
 * Graph node and relationship type definitions.
 *
 * These represent the core data model of the Engineering Knowledge Graph.
 * Nodes are entities (services, files, databases), relationships are edges
 * connecting them with semantic meaning.
 */

import type { ConfigKind, SecretVendor } from '../constants.js';

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
  | 'Commit'
  | 'ConfigKey'
  | 'SecretRef'
  | 'Vault';

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
  | 'TOUCHED'
  | 'USES_SECRET';

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

export type ApiSpecVersion =
  | 'openapi-3'
  | 'swagger-2'
  | 'graphql-sdl'
  | 'grpc-proto3'
  | 'grpc-proto2';

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

/** Encode headings as parallel primitive arrays for Neo4j storage. */
export function encodeDocHeadings(
  headings: readonly DocHeading[],
): { headingLevels: number[]; headingTexts: string[] } {
  return {
    headingLevels: headings.map((h) => h.level),
    headingTexts: headings.map((h) => h.text),
  };
}

/** Reconstruct headings from parallel primitive arrays. */
export function readDocHeadings(props: {
  headingLevels?: readonly number[];
  headingTexts?: readonly string[];
}): readonly DocHeading[] {
  const levels = props.headingLevels ?? [];
  const texts = props.headingTexts ?? [];
  const n = Math.min(levels.length, texts.length);
  const out: DocHeading[] = [];
  for (let i = 0; i < n; i++) out.push({ level: levels[i]!, text: texts[i]! });
  return out;
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
    // Stored as parallel primitive arrays — Neo4j rejects nested objects on
    // node properties. Use `readDocHeadings()` from @ekg/shared to reconstruct.
    headingLevels: readonly number[];
    headingTexts: readonly string[];
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

// -- Config & Secret Nodes (Phase 1.6) --

/**
 * A single configuration key — finer-grained than `Config` (file-level).
 * Captures the *reference* and *default*, never the resolved runtime value.
 */
export interface ConfigKeyNode extends GraphNode {
  readonly label: 'ConfigKey';
  readonly properties: Readonly<{
    key: string;
    repoUrl: string;
    filePath: string;
    sourceLine: number;
    kind: ConfigKind;
    /** Default literal lifted from the source — may be empty string. */
    defaultValue?: string;
    /** Environment qualifier inferred from filename suffix, e.g. `prod`, `staging`. */
    envScope?: string;
    /** Heuristic — true when the key name suggests a secret. Never set from a resolved value. */
    isSecret: boolean;
    /** Original raw fragment for provenance. Bounded length. */
    raw?: string;
  }>;
}

/**
 * A reference to a secret stored in an external vault. Captures the path /
 * ARN / URI only — never the secret material itself.
 */
export interface SecretRefNode extends GraphNode {
  readonly label: 'SecretRef';
  readonly properties: Readonly<{
    vendor: SecretVendor;
    /** Vendor-native reference: e.g. `vault:secret/data/users#api_key`,
     *  `arn:aws:secretsmanager:us-east-1:123:secret:foo-AbCdEf`,
     *  `k8s:my-secret#API_KEY`. */
    ref: string;
    repoUrl: string;
    filePath: string;
    sourceLine: number;
    /**
     * Vault-style namespace lifted from `ref` by `vault.path.parser`. Set
     * post-emission so existing extractors do not need to compute it.
     * Examples: `secret/data/users`, ARN sans trailing `:<key>`.
     */
    mountPath?: string;
  }>;
}

/**
 * Vault namespace node — clusters multiple `SecretRef`s sharing a mount path
 * (e.g. `vault:secret/data/users#api_key` and `vault:secret/data/users#refresh_token`).
 *
 * Emitted post-extraction by the pipeline; one Vault per (vendor, mountPath).
 * Edge: `Vault -[CONTAINS]-> SecretRef`.
 */
export interface VaultNode extends GraphNode {
  readonly label: 'Vault';
  readonly properties: Readonly<{
    mountPath: string;
    vendor: SecretVendor;
    repoUrl: string;
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
