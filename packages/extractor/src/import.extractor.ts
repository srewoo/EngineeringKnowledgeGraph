/**
 * Import extractor — converts parsed imports into graph nodes and edges.
 *
 * Transforms raw AST import data into graph-ready nodes (Module, File)
 * and relationships (IMPORTS) with appropriate confidence scores.
 */

import { createLogger } from '@ekg/shared';
import type {
  GraphNode,
  GraphRelationship,
  ParseResult,
  Logger,
} from '@ekg/shared';

export interface ImportExtractionResult {
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
}

export class ImportExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'import-extractor' });
  }

  /**
   * Extract graph nodes and relationships from a parse result's imports.
   */
  extract(parseResult: ParseResult, repoUrl: string): ImportExtractionResult {
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const fileId = `${repoUrl}:${parseResult.filePath}`;

    // File node for source
    nodes.push({
      id: fileId,
      label: 'File',
      name: parseResult.filePath.split('/').pop() ?? parseResult.filePath,
      properties: {
        path: parseResult.filePath,
        language: this.detectLanguage(parseResult.filePath),
        repoUrl,
        hash: '',
      },
    });

    for (const imp of parseResult.imports) {
      // Skip type-only imports — they don't create runtime dependencies
      if (imp.isTypeOnly) continue;

      const moduleId = imp.isLocal
        ? `${repoUrl}:${this.resolveLocalPath(parseResult.filePath, imp.source)}`
        : `npm:${imp.source}`;

      // Module node
      nodes.push({
        id: moduleId,
        label: 'Module',
        name: imp.source,
        properties: {
          packageName: imp.source,
          isLocal: imp.isLocal,
        },
      });

      // IMPORTS relationship
      relationships.push({
        type: 'IMPORTS',
        sourceId: fileId,
        targetId: moduleId,
        confidence: imp.isLocal ? 'HIGH' : 'HIGH',
        properties: {
          specifiers: imp.specifiers.join(', '),
        },
      });
    }

    // Export nodes
    for (const exp of parseResult.exports) {
      if (exp.isTypeOnly) continue;

      relationships.push({
        type: 'EXPORTS',
        sourceId: fileId,
        targetId: fileId,
        confidence: 'HIGH',
        properties: {
          exportName: exp.name,
          exportKind: exp.kind,
        },
      });
    }

    // Database usage
    for (const db of parseResult.databaseUsages) {
      const dbId = `db:${db.databaseType.toLowerCase()}`;

      nodes.push({
        id: dbId,
        label: 'Database',
        name: db.databaseType,
        properties: {
          type: db.databaseType,
          detectedVia: db.detectedVia,
        },
      });

      relationships.push({
        type: 'USES',
        sourceId: fileId,
        targetId: dbId,
        confidence: 'HIGH',
        properties: {
          packageName: db.packageName,
        },
      });
    }

    // API routes
    for (const route of parseResult.routes) {
      const apiId = `api:${route.method}:${route.path}`;

      nodes.push({
        id: apiId,
        label: 'API',
        name: `${route.method} ${route.path}`,
        properties: {
          method: route.method,
          path: route.path,
          framework: route.framework,
        },
      });

      relationships.push({
        type: 'EXPOSES',
        sourceId: fileId,
        targetId: apiId,
        confidence: 'HIGH',
        properties: {
          handler: route.handlerName,
        },
      });
    }

    // HTTP calls (cross-service)
    for (const call of parseResult.httpCalls) {
      const callId = `http-call:${call.method}:${call.url}`;

      relationships.push({
        type: 'CALLS',
        sourceId: fileId,
        targetId: callId,
        confidence: 'MEDIUM',
        properties: {
          url: call.url,
          method: call.method,
          clientLibrary: call.clientLibrary,
        },
      });
    }

    // Environment variables
    for (const envVar of parseResult.envVars) {
      const configId = `config:env:${envVar}`;

      nodes.push({
        id: configId,
        label: 'Config',
        name: envVar,
        properties: {},
      });

      relationships.push({
        type: 'READS_CONFIG',
        sourceId: fileId,
        targetId: configId,
        confidence: 'HIGH',
        properties: {},
      });
    }

    this.logger.debug({
      filePath: parseResult.filePath,
      nodes: nodes.length,
      relationships: relationships.length,
    }, 'Import extraction completed');

    return { nodes, relationships };
  }

  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
    };
    return languageMap[ext ?? ''] ?? 'unknown';
  }

  private resolveLocalPath(fromFile: string, importSource: string): string {
    // Simplified path resolution — joins the directory of the source file
    // with the import path. In production, ts-morph's resolution is better.
    const dir = fromFile.split('/').slice(0, -1).join('/');
    return `${dir}/${importSource}`.replace(/\/\.\//g, '/');
  }
}
