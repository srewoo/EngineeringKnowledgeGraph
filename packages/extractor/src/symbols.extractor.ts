/**
 * Symbols extractor — turns ParsedSymbols into graph nodes + relationships.
 *
 * Phase 1.3 — TypeScript/JavaScript only. Other languages get nothing
 * (the multi-language parser doesn't populate `symbols`).
 *
 * The parser emits symbol ids scoped to the absolute filePath. We re-prefix
 * with `${repoUrl}:` here so ids stay unique across repos and remain
 * consistent with the existing File node id (`${repoUrl}:${filePath}`).
 *
 * Confidence rules:
 *   - DEFINES, EXTENDS (same-file), USES (same-file)  → HIGH
 *   - EXTENDS (cross-module), CALLS (cross-module),
 *     USES (cross-module imported)                    → MEDIUM
 *   - Unresolved targets are kept as `name@modulePath` reference ids;
 *     downstream merge will simply not find them and skip the edge.
 */

import type {
  GraphNode,
  GraphRelationship,
  ParsedSymbols,
  ParsedFunction,
  ParsedClass,
  ParsedMethod,
  ParsedTypeDef,
  EdgeConfidence,
} from '@ekg/shared';

export interface SymbolsExtractionResult {
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
}

export class SymbolsExtractor {
  /**
   * Build graph nodes/edges from parsed symbols. `filePath` matches
   * `parseResult.filePath` exactly so the rewriting prefix is correct.
   */
  extract(
    symbols: ParsedSymbols,
    repoUrl: string,
    filePath: string,
    language: string,
  ): SymbolsExtractionResult {
    const fileId = `${repoUrl}:${filePath}`;
    const prefix = `${repoUrl}:`;
    const rewrite = (id: string): string => (this.isLocalId(id) ? `${prefix}${id}` : id);

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];

    for (const fn of symbols.functions) {
      const id = rewrite(fn.id);
      nodes.push(this.functionNode(id, fn, repoUrl, filePath, language));
      relationships.push(this.edge('DEFINES', fileId, id, 'HIGH', { kind: 'function' }));
    }

    for (const cls of symbols.classes) {
      const id = rewrite(cls.id);
      nodes.push(this.classNode(id, cls, repoUrl, filePath, language));
      relationships.push(this.edge('DEFINES', fileId, id, 'HIGH', { kind: 'class' }));
      if (cls.extendsRef) {
        const target = rewrite(cls.extendsRef);
        const conf: EdgeConfidence = this.isLocalId(cls.extendsRef) ? 'HIGH' : 'MEDIUM';
        relationships.push(this.edge('EXTENDS', id, target, conf, {}));
      }
    }

    for (const m of symbols.methods) {
      const id = rewrite(m.id);
      const classId = rewrite(m.classId);
      nodes.push(this.methodNode(id, m, classId));
      relationships.push(this.edge('DEFINES', classId, id, 'HIGH', { kind: 'method' }));
    }

    for (const td of symbols.typeDefs) {
      const id = rewrite(td.id);
      nodes.push(this.typeDefNode(id, td, repoUrl, filePath));
      relationships.push(this.edge('DEFINES', fileId, id, 'HIGH', { kind: td.kind }));
    }

    for (const call of symbols.calls) {
      const sourceId = rewrite(call.sourceId);
      const targetId = rewrite(call.targetId);
      const conf: EdgeConfidence = call.resolved ? 'HIGH' : 'MEDIUM';
      relationships.push(this.edge('CALLS', sourceId, targetId, conf, {
        resolved: call.resolved,
      }));
    }

    for (const tu of symbols.typeUses) {
      const sourceId = rewrite(tu.sourceId);
      const targetId = rewrite(tu.targetId);
      const conf: EdgeConfidence = tu.resolved ? 'HIGH' : 'MEDIUM';
      relationships.push(this.edge('USES', sourceId, targetId, conf, {
        kind: 'type',
        resolved: tu.resolved,
      }));
    }

    return { nodes, relationships };
  }

  /** Local ids are the ones the parser emitted (start with `fn:`/`cls:`/`method:`/`type:`). */
  private isLocalId(id: string): boolean {
    return id.startsWith('fn:') || id.startsWith('cls:')
      || id.startsWith('method:') || id.startsWith('type:');
  }

  private edge(
    type: GraphRelationship['type'],
    sourceId: string,
    targetId: string,
    confidence: EdgeConfidence,
    properties: Record<string, unknown>,
  ): GraphRelationship {
    return { type, sourceId, targetId, confidence, properties };
  }

  private functionNode(
    id: string, fn: ParsedFunction, repoUrl: string, filePath: string, language: string,
  ): GraphNode {
    return {
      id, label: 'Function', name: fn.name,
      properties: {
        name: fn.name,
        repoUrl,
        filePath,
        language,
        signature: fn.signature,
        ...(fn.docComment ? { docComment: fn.docComment } : {}),
        lineStart: fn.lineStart,
        lineEnd: fn.lineEnd,
        isExported: fn.isExported,
        isAsync: fn.isAsync,
        complexity: fn.complexity,
        sourceLine: fn.lineStart,
      },
    };
  }

  private classNode(
    id: string, cls: ParsedClass, repoUrl: string, filePath: string, language: string,
  ): GraphNode {
    return {
      id, label: 'Class', name: cls.name,
      properties: {
        name: cls.name,
        repoUrl,
        filePath,
        language,
        lineStart: cls.lineStart,
        lineEnd: cls.lineEnd,
        isExported: cls.isExported,
        isAbstract: cls.isAbstract,
        ...(cls.docComment ? { docComment: cls.docComment } : {}),
        sourceLine: cls.lineStart,
      },
    };
  }

  private methodNode(id: string, m: ParsedMethod, classId: string): GraphNode {
    return {
      id, label: 'Method', name: m.name,
      properties: {
        classId,
        name: m.name,
        signature: m.signature,
        ...(m.docComment ? { docComment: m.docComment } : {}),
        lineStart: m.lineStart,
        lineEnd: m.lineEnd,
        isStatic: m.isStatic,
        isAsync: m.isAsync,
        visibility: m.visibility,
        complexity: m.complexity,
        sourceLine: m.lineStart,
      },
    };
  }

  private typeDefNode(
    id: string, td: ParsedTypeDef, repoUrl: string, filePath: string,
  ): GraphNode {
    return {
      id, label: 'TypeDef', name: td.name,
      properties: {
        name: td.name,
        kind: td.kind,
        repoUrl,
        filePath,
        lineStart: td.lineStart,
        lineEnd: td.lineEnd,
        isExported: td.isExported,
        sourceLine: td.lineStart,
      },
    };
  }
}
