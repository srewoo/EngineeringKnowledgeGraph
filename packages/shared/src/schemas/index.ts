/**
 * Zod schemas for runtime validation of all external inputs.
 *
 * Used at MCP tool boundaries, config file loading, and API inputs.
 * Every external input must pass through a schema before processing.
 */

import { z } from 'zod';

// -- Config Schemas --

export const repoConfigSchema = z.object({
  url: z.string().min(1, 'Repo URL is required'),
  branch: z.string().default('main'),
  token: z.string().optional(),
  serviceMappings: z.record(z.string(), z.string()).optional(),
});

export const ekgConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1, 'At least one repo is required'),
  ignoreDirs: z.array(z.string()).default([
    'node_modules', 'dist', 'build', '.git', 'coverage', 'vendor',
  ]),
  supportedExtensions: z.array(z.string()).default([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  ]),
});

// -- Environment Schema --

export const envConfigSchema = z.object({
  neo4jUri: z.string().default('bolt://localhost:7687'),
  neo4jUser: z.string().default('neo4j'),
  neo4jPassword: z.string().default('ekg-local-dev'),
  gitToken: z.string().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  dataDir: z.string().default('./data'),
  gitlabUrl: z.string().default('https://gitlab.com'),
  gitlabGroupIds: z.string().optional(),
  maxRepoSizeMb: z.coerce.number().positive().default(1024),
  bulkConcurrency: z.coerce.number().int().positive().max(32).default(5),
  ingestTimeoutMs: z.coerce.number().int().positive().min(60_000).default(600_000),
});

// -- MCP Tool Input Schemas --

export const ingestRepoInputSchema = z.object({
  url: z.string().min(1, 'Repository URL is required'),
  branch: z.string().default('main'),
  token: z.string().optional(),
});

export const searchCodebaseInputSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  type: z.enum([
    'Service', 'API', 'Database', 'Repo', 'File',
    'Module', 'Config', 'MessageQueue',
  ]).optional(),
  limit: z.number().int().positive().max(100).default(20),
});

export const getDependenciesInputSchema = z.object({
  service: z.string().min(1, 'Service name is required'),
  depth: z.number().int().positive().max(10).default(2),
});

export const analyzeImpactInputSchema = z.object({
  node: z.string().min(1, 'Node name is required'),
  changeType: z.enum(['api_change', 'db_change', 'removal', 'modification']).optional(),
  depth: z.number().int().positive().max(10).default(3),
});

export const getServiceSummaryInputSchema = z.object({
  service: z.string().min(1, 'Service name is required'),
});

export const getIngestionStatusInputSchema = z.object({
  repo: z.string().min(1, 'Repository URL or name is required'),
});

export const getApiMapInputSchema = z.object({
  service: z.string().optional(),
});

// -- Doc Schemas --

export const docKindSchema = z.enum(['README', 'RUNBOOK', 'ADR', 'CHANGELOG', 'PRD', 'OTHER']);

export const docHeadingSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
});

export const codeBlockSchema = z.object({
  language: z.string(),
  code: z.string(),
  startLine: z.number().int().nonnegative(),
});

export const docLinkSchema = z.object({
  text: z.string(),
  url: z.string(),
});

export const docNodeSchema = z.object({
  path: z.string().min(1),
  repoUrl: z.string().min(1),
  kind: docKindSchema,
  title: z.string(),
  headings: z.array(docHeadingSchema),
  rawText: z.string(),
  codeBlockCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  format: z.enum(['markdown', 'mdx', 'rst', 'adoc']),
});

// -- Schema (DB) Node Schemas --

export const tableNodeSchema = z.object({
  name: z.string().min(1),
  schema: z.string().optional(),
  repoUrl: z.string().min(1),
  filePath: z.string().min(1),
  sourceLine: z.number().int().nonnegative(),
  raw: z.string().optional(),
});

export const columnNodeSchema = z.object({
  tableId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean(),
  isPrimary: z.boolean(),
  isUnique: z.boolean(),
  isList: z.boolean().optional(),
  defaultValue: z.string().optional(),
  mappedName: z.string().optional(),
});

export const migrationNodeSchema = z.object({
  name: z.string().min(1),
  filePath: z.string().min(1),
  repoUrl: z.string().min(1),
  appliedAt: z.string().optional(),
});

// -- API (OpenAPI / Swagger) Node Schemas --

export const apiSpecVersionSchema = z.enum(['openapi-3', 'swagger-2']);

export const apiNodeSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  framework: z.string().min(1),
  // Phase 1.5 enrichment — all optional.
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  requestSchema: z.unknown().optional(),
  responseSchemas: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  specVersion: apiSpecVersionSchema.optional(),
  specPath: z.string().optional(),
});

// -- Symbol Node Schemas (Phase 1.3) --

export const typeDefKindSchema = z.enum(['interface', 'type-alias', 'enum']);

export const methodVisibilitySchema = z.enum(['public', 'private', 'protected']);

export const functionNodeSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  filePath: z.string().min(1),
  language: z.string().min(1),
  signature: z.string(),
  docComment: z.string().optional(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  isExported: z.boolean(),
  isAsync: z.boolean(),
  complexity: z.number().int().nonnegative().optional(),
  sourceLine: z.number().int().nonnegative(),
});

export const classNodeSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  filePath: z.string().min(1),
  language: z.string().min(1),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  isExported: z.boolean(),
  isAbstract: z.boolean(),
  docComment: z.string().optional(),
  sourceLine: z.number().int().nonnegative(),
});

export const methodNodeSchema = z.object({
  classId: z.string().min(1),
  name: z.string().min(1),
  signature: z.string(),
  docComment: z.string().optional(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  isStatic: z.boolean(),
  isAsync: z.boolean(),
  visibility: methodVisibilitySchema,
  complexity: z.number().int().nonnegative().optional(),
  sourceLine: z.number().int().nonnegative(),
});

export const typeDefNodeSchema = z.object({
  name: z.string().min(1),
  kind: typeDefKindSchema,
  repoUrl: z.string().min(1),
  filePath: z.string().min(1),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  isExported: z.boolean(),
  sourceLine: z.number().int().nonnegative(),
});

// -- Ownership / Commit Schemas (Phase 1.7) --

export const ownerKindSchema = z.enum(['user', 'team', 'email']);

export const ownerNodeSchema = z.object({
  identifier: z.string().min(1),
  kind: ownerKindSchema,
  repoUrl: z.string().min(1),
});

export const teamNodeSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
});

export const commitNodeSchema = z.object({
  sha: z.string().min(1),
  repoUrl: z.string().min(1),
  author: z.string(),
  authorEmail: z.string(),
  message: z.string().max(500),
  authoredAt: z.string(),
  parentShas: z.array(z.string()),
});

// -- Inferred Types --

export type IngestRepoInput = z.infer<typeof ingestRepoInputSchema>;
export type SearchCodebaseInput = z.infer<typeof searchCodebaseInputSchema>;
export type GetDependenciesInput = z.infer<typeof getDependenciesInputSchema>;
export type AnalyzeImpactInput = z.infer<typeof analyzeImpactInputSchema>;
export type GetServiceSummaryInput = z.infer<typeof getServiceSummaryInputSchema>;
export type GetIngestionStatusInput = z.infer<typeof getIngestionStatusInputSchema>;
export type GetApiMapInput = z.infer<typeof getApiMapInputSchema>;
