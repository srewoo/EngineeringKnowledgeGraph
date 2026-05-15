/**
 * Embedder — orchestrates: build text → hash → skip-if-exists → call provider
 * → upsert rows. Pure logic, no file I/O. Callers supply text fragments
 * (and a body provider for functions).
 */

import { createHash } from 'node:crypto';
import { createLogger, type Logger, type DocHeading } from '@ekg/shared';
import type { EmbeddingsRepository, EmbeddingRow } from '@ekg/storage';
import type { EmbeddingProvider } from './provider.interface.js';
import { chunkDoc } from './doc.chunker.js';

const MAX_TEXT_BYTES = 8 * 1024;
const DOC_CHUNK_CHARS = 2000;
const DOC_CHUNK_OVERLAP_RATIO = 0.15;
const PROVIDER_BATCH_SIZE = 32;

export type EmbeddableLabel = 'Function' | 'Doc' | 'Table' | 'API';

export interface FunctionEmbeddable {
  readonly kind: 'Function';
  readonly nodeId: string;
  readonly signature: string;
  readonly docComment?: string;
  /** Provides the first N lines of the function body (≤30). May reject. */
  readonly bodyProvider?: () => Promise<string>;
}

export interface DocEmbeddable {
  readonly kind: 'Doc';
  readonly nodeId: string;
  readonly title: string;
  readonly text: string;
  /** Phase 2 follow-up: when present, the embedder uses heading-aware chunking. */
  readonly headings?: readonly DocHeading[];
}

export interface TableEmbeddable {
  readonly kind: 'Table';
  readonly nodeId: string;
  readonly tableName: string;
  /** Columns rendered as `name:type` pairs. */
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  readonly leadingComment?: string;
}

export interface ApiEmbeddable {
  readonly kind: 'API';
  readonly nodeId: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly operationId?: string;
  readonly requestSchemaKeys?: readonly string[];
  readonly responseSchemaKeys?: readonly string[];
}

export type EmbeddableInput = FunctionEmbeddable | DocEmbeddable | TableEmbeddable | ApiEmbeddable;

interface PreparedItem {
  readonly id: string;          // row id, includes chunk suffix for docs
  readonly label: EmbeddableLabel;
  readonly nodeId: string;
  readonly text: string;        // already truncated to MAX_TEXT_BYTES
  readonly contentHash: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class Embedder {
  private readonly provider: EmbeddingProvider;
  private readonly repo: EmbeddingsRepository;
  private readonly repoUrl: string;
  private readonly logger: Logger;

  constructor(provider: EmbeddingProvider, repo: EmbeddingsRepository, repoUrl: string) {
    this.provider = provider;
    this.repo = repo;
    this.repoUrl = repoUrl;
    this.logger = createLogger({ service: 'embedder' });
  }

  /**
   * Embed a list of nodes. Hashes content, skips already-embedded items,
   * batches the rest through the provider, and upserts rows.
   */
  async embedNodes(nodes: readonly EmbeddableInput[]): Promise<{ embedded: number; skipped: number }> {
    const prepared: PreparedItem[] = [];
    for (const node of nodes) {
      for (const item of await this.prepare(node)) {
        prepared.push(item);
      }
    }

    // Skip-if-already-embedded
    const todo = prepared.filter((p) => !this.repo.findByContentHash(p.contentHash));
    const skipped = prepared.length - todo.length;
    if (todo.length === 0) {
      this.logger.info({ skipped, total: prepared.length }, 'All embeddings up-to-date');
      return { embedded: 0, skipped };
    }

    const rows: EmbeddingRow[] = [];
    for (let i = 0; i < todo.length; i += PROVIDER_BATCH_SIZE) {
      const batch = todo.slice(i, i + PROVIDER_BATCH_SIZE);
      const vectors = await this.provider.embed(batch.map((b) => b.text));
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const vec = vectors[j];
        if (!vec || vec.length !== this.provider.dimensions) {
          this.logger.warn({ id: item.id, got: vec?.length ?? 0, expected: this.provider.dimensions }, 'Skipping vector with wrong dimensions');
          continue;
        }
        rows.push({
          id: item.id,
          label: item.label,
          nodeId: item.nodeId,
          repoUrl: this.repoUrl,
          contentHash: item.contentHash,
          provider: this.provider.id,
          model: this.provider.model,
          dimensions: this.provider.dimensions,
          vector: toFloat32Buffer(vec),
          textUsed: item.text,
          createdAt: new Date().toISOString(),
          ...(item.metadata ? { metadata: JSON.stringify(item.metadata) } : {}),
        });
      }
    }

    this.repo.upsert(rows);
    this.logger.info({ embedded: rows.length, skipped }, 'Embedding batch upserted');
    return { embedded: rows.length, skipped };
  }

  private async prepare(node: EmbeddableInput): Promise<readonly PreparedItem[]> {
    switch (node.kind) {
      case 'Function': return [await this.prepareFunction(node)];
      case 'Doc': return this.prepareDoc(node);
      case 'Table': return [this.prepareTable(node)];
      case 'API': return [this.prepareApi(node)];
    }
  }

  private async prepareFunction(node: FunctionEmbeddable): Promise<PreparedItem> {
    let body = '';
    if (node.bodyProvider) {
      try {
        const raw = await node.bodyProvider();
        body = raw.split('\n').slice(0, 30).join('\n');
      } catch {
        body = '';
      }
    }
    const text = truncate(
      [node.signature, node.docComment ?? '', body].filter(Boolean).join('\n\n'),
    );
    return {
      id: `Function:${node.nodeId}`,
      label: 'Function',
      nodeId: node.nodeId,
      text,
      contentHash: sha256(text),
    };
  }

  private prepareDoc(node: DocEmbeddable): readonly PreparedItem[] {
    if (node.headings && node.headings.length > 0) {
      const chunks = chunkDoc({ title: node.title, headings: node.headings, rawText: node.text });
      return chunks.map((c, idx) => {
        const text = truncate(c.text);
        return {
          id: `Doc:${node.nodeId}#chunk:${idx}`,
          label: 'Doc' as const,
          nodeId: node.nodeId,
          text,
          contentHash: sha256(text),
          metadata: {
            title: node.title,
            breadcrumb: c.breadcrumb,
            headingLevel: c.headingLevel,
            lineRange: c.lineRange,
          },
        };
      });
    }
    // Fallback: legacy char-based chunker, breadcrumb-prefixed for consistency.
    const breadcrumb = `[${node.title.trim()}]`;
    const fullText = `${breadcrumb}\n${node.text}`;
    const chunks = chunkText(fullText, DOC_CHUNK_CHARS, DOC_CHUNK_OVERLAP_RATIO);
    return chunks.map((chunk, idx) => {
      const text = truncate(chunk);
      return {
        id: `Doc:${node.nodeId}#chunk:${idx}`,
        label: 'Doc' as const,
        nodeId: node.nodeId,
        text,
        contentHash: sha256(text),
        metadata: { title: node.title, breadcrumb, headingLevel: 0 },
      };
    });
  }

  private prepareTable(node: TableEmbeddable): PreparedItem {
    const cols = node.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    const text = truncate(
      [node.leadingComment ?? '', `TABLE ${node.tableName}`, `COLUMNS: ${cols}`]
        .filter(Boolean)
        .join('\n'),
    );
    return {
      id: `Table:${node.nodeId}`,
      label: 'Table',
      nodeId: node.nodeId,
      text,
      contentHash: sha256(text),
    };
  }

  private prepareApi(node: ApiEmbeddable): PreparedItem {
    const reqKeys = (node.requestSchemaKeys ?? []).join(', ');
    const respKeys = (node.responseSchemaKeys ?? []).join(', ');
    const text = truncate([
      `${node.method.toUpperCase()} ${node.path}`,
      node.operationId ? `operationId: ${node.operationId}` : '',
      node.summary ?? '',
      reqKeys ? `request: ${reqKeys}` : '',
      respKeys ? `response: ${respKeys}` : '',
    ].filter(Boolean).join('\n'));
    return {
      id: `API:${node.nodeId}`,
      label: 'API',
      nodeId: node.nodeId,
      text,
      contentHash: sha256(text),
    };
  }
}

// -- helpers --

export function chunkText(text: string, chunkChars: number, overlapRatio: number): readonly string[] {
  if (text.length <= chunkChars) return [text];
  const overlap = Math.floor(chunkChars * overlapRatio);
  const stride = Math.max(1, chunkChars - overlap);
  const out: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    const slice = text.slice(start, start + chunkChars);
    if (slice.length === 0) break;
    out.push(slice);
    if (start + chunkChars >= text.length) break;
  }
  return out;
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return text;
  // Truncate by codepoint to avoid splitting multibyte sequences.
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES);
  return buf.toString('utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toFloat32Buffer(values: readonly number[]): Buffer {
  const arr = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) arr[i] = values[i] ?? 0;
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
