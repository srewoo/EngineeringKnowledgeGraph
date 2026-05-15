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
  | 'Feature'
  | 'TestCase'
  | 'Owner'
  | 'Team';

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
  | 'MEMBER_OF';

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

export interface ApiNode extends GraphNode {
  readonly label: 'API';
  readonly properties: Readonly<{
    method: string;
    path: string;
    framework: string;
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

// -- Relationship --

export interface GraphRelationship {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence: EdgeConfidence;
  readonly properties: Readonly<Record<string, unknown>>;
}

// -- Extraction Result --

export interface ExtractionResult {
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
  readonly sourceFile: string;
  readonly repoUrl: string;
}
