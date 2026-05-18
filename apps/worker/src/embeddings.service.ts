/**
 * EmbeddingsService — best-effort post-ingest embedder.
 *
 * Translates the deduped graph nodes from an extraction result into the
 * `EmbeddableInput` shape and runs them through the Embedder. NEVER throws;
 * embedding failures are warned and swallowed so they cannot fail an ingest.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, type Logger, type GraphNode, type GraphRelationship } from '@ekg/shared';
import {
  Embedder,
  getEmbeddingProvider,
  type EmbeddableInput,
  type EmbeddingProvider,
  type FunctionEmbeddable,
  type DocEmbeddable,
  type TableEmbeddable,
  type ApiEmbeddable,
} from '@ekg/embeddings';
import { EmbeddingsRepository } from '@ekg/storage';

export interface EmbeddingsServiceOptions {
  readonly enabled: boolean;
  readonly dbPath: string;
  /** Override provider (tests). */
  readonly provider?: EmbeddingProvider;
}

export class EmbeddingsService {
  readonly enabled: boolean;
  private readonly repo?: EmbeddingsRepository;
  private readonly providerOverride?: EmbeddingProvider;
  private readonly logger: Logger;

  constructor(opts: EmbeddingsServiceOptions) {
    this.enabled = opts.enabled;
    this.providerOverride = opts.provider;
    this.logger = createLogger({ service: 'embeddings-service' });
    if (this.enabled) {
      this.repo = new EmbeddingsRepository(opts.dbPath);
    }
  }

  /** Exposed for the MCP search tool. Returns undefined when disabled. */
  getRepository(): EmbeddingsRepository | undefined {
    return this.repo;
  }

  /** Exposed for the MCP search tool — embed the user query at search time. */
  getProvider(): EmbeddingProvider | undefined {
    if (!this.enabled) return undefined;
    return this.providerOverride ?? getEmbeddingProvider();
  }

  /**
   * Embed the four supported node kinds from a finished extraction.
   * Best-effort — never throws.
   */
  async embedFromExtraction(
    repoUrl: string,
    repoLocalPath: string,
    nodes: readonly GraphNode[],
    relationships: readonly GraphRelationship[],
  ): Promise<void> {
    if (!this.enabled || !this.repo) return;

    let provider: EmbeddingProvider;
    try {
      provider = this.providerOverride ?? getEmbeddingProvider();
    } catch (err) {
      this.logger.warn({ err: errorMessage(err) }, 'Embeddings provider init failed; skipping');
      return;
    }

    try {
      const inputs = this.buildInputs(nodes, relationships, repoLocalPath);
      if (inputs.length === 0) {
        this.logger.info({ repoUrl }, 'No embeddable nodes in extraction');
        return;
      }
      const embedder = new Embedder(provider, this.repo, repoUrl);
      const result = await embedder.embedNodes(inputs);
      this.logger.info({ repoUrl, ...result, total: inputs.length }, 'Embeddings step complete');
    } catch (err) {
      this.logger.warn({ repoUrl, err: errorMessage(err) }, 'Embeddings step failed (non-fatal)');
    }
  }

  /**
   * Invalidate stale embeddings after a schema-drift event so the next
   * embed pass refreshes the affected nodes. Conservative scope: drop
   * all Function / Doc / Table embeddings for the repo. Cost is bounded
   * because drift events are rare (one per migration commit).
   */
  invalidateAfterSchemaDrift(repoUrl: string): { deleted: number } {
    if (!this.enabled || !this.repo) return { deleted: 0 };
    let deleted = 0;
    for (const label of ['Function', 'Doc', 'Table'] as const) {
      deleted += this.repo.deleteByLabelAndRepo(label, repoUrl);
    }
    this.logger.info(
      { repoUrl, deleted },
      'Embeddings invalidated after schema-drift event',
    );
    return { deleted };
  }

  close(): void {
    this.repo?.close();
  }

  // -- input builders --

  private buildInputs(
    nodes: readonly GraphNode[],
    relationships: readonly GraphRelationship[],
    repoLocalPath: string,
  ): readonly EmbeddableInput[] {
    const out: EmbeddableInput[] = [];

    // Pre-index Table → Column via HAS edges
    const columnsByTable = new Map<string, { name: string; type: string }[]>();
    const columnNodeById = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (n.label === 'Column') columnNodeById.set(n.id, n);
    }
    for (const rel of relationships) {
      if (rel.type !== 'HAS') continue;
      const col = columnNodeById.get(rel.targetId);
      if (!col) continue;
      const props = col.properties as { name?: string; type?: string };
      const list = columnsByTable.get(rel.sourceId) ?? [];
      list.push({ name: props.name ?? col.name, type: props.type ?? 'unknown' });
      columnsByTable.set(rel.sourceId, list);
    }

    for (const node of nodes) {
      const input = this.nodeToEmbeddable(node, columnsByTable, repoLocalPath);
      if (input) out.push(input);
    }
    return out;
  }

  private nodeToEmbeddable(
    node: GraphNode,
    columnsByTable: ReadonlyMap<string, { name: string; type: string }[]>,
    repoLocalPath: string,
  ): EmbeddableInput | undefined {
    switch (node.label) {
      case 'Function': return this.functionInput(node, repoLocalPath);
      case 'Doc': return this.docInput(node);
      case 'Table': return this.tableInput(node, columnsByTable);
      case 'API': return this.apiInput(node);
      default: return undefined;
    }
  }

  private functionInput(node: GraphNode, repoLocalPath: string): FunctionEmbeddable {
    const props = node.properties as {
      signature?: string; docComment?: string; filePath?: string; lineStart?: number; lineEnd?: number;
    };
    const filePath = props.filePath;
    const lineStart = props.lineStart;
    const lineEnd = props.lineEnd;
    const bodyProvider = filePath && lineStart && lineEnd
      ? async () => readBodyLines(join(repoLocalPath, filePath), lineStart, lineEnd)
      : undefined;
    return {
      kind: 'Function',
      nodeId: node.id,
      signature: props.signature ?? node.name,
      ...(props.docComment ? { docComment: props.docComment } : {}),
      ...(bodyProvider ? { bodyProvider } : {}),
    };
  }

  private docInput(node: GraphNode): DocEmbeddable {
    const props = node.properties as { title?: string; rawText?: string };
    return {
      kind: 'Doc',
      nodeId: node.id,
      title: props.title ?? node.name,
      text: props.rawText ?? '',
    };
  }

  private tableInput(
    node: GraphNode,
    columnsByTable: ReadonlyMap<string, { name: string; type: string }[]>,
  ): TableEmbeddable {
    const props = node.properties as { name?: string; raw?: string };
    return {
      kind: 'Table',
      nodeId: node.id,
      tableName: props.name ?? node.name,
      columns: columnsByTable.get(node.id) ?? [],
      ...(props.raw ? { leadingComment: props.raw } : {}),
    };
  }

  private apiInput(node: GraphNode): ApiEmbeddable {
    const props = node.properties as {
      method?: string; path?: string; summary?: string; operationId?: string;
      // Schemas are JSON-stringified on the graph; parseSchema() round-trips them.
      requestSchema?: unknown; responseSchemas?: unknown;
    };
    return {
      kind: 'API',
      nodeId: node.id,
      method: props.method ?? 'GET',
      path: props.path ?? node.name,
      ...(props.summary ? { summary: props.summary } : {}),
      ...(props.operationId ? { operationId: props.operationId } : {}),
      requestSchemaKeys: flattenKeys(parseSchema(props.requestSchema)),
      responseSchemaKeys: Object.values(parseSchema(props.responseSchemas) ?? {}).flatMap((s) => flattenKeys(s)),
    };
  }
}

async function readBodyLines(absolutePath: string, lineStart: number, lineEnd: number): Promise<string> {
  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(0, lineStart - 1);
  const end = Math.min(lines.length, lineEnd);
  return lines.slice(start, end).join('\n');
}

/**
 * Schema fields are now stored on the graph as JSON strings (see
 * openapi.extractor — Neo4j rejects nested-object properties). Parse the
 * string back to an object for keyword extraction; pass-through values
 * that are already objects stay as-is.
 */
function parseSchema(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length === 0) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function flattenKeys(schema: unknown, prefix = '', depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth > 4) return [];
  const obj = schema as Record<string, unknown>;
  const keys: string[] = [];
  const props = obj['properties'];
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      keys.push(path);
      keys.push(...flattenKeys(v, path, depth + 1));
    }
  }
  return keys.slice(0, 50);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
