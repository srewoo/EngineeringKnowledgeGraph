/**
 * SearchIndexService — best-effort post-ingest BM25 indexer.
 *
 * Always runs (no env flag): BM25 over SQLite FTS5 is local + free.
 * Mirrors the text the embedder uses so vector + BM25 see the same view.
 * NEVER throws — failures are warned and swallowed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, type Logger, type GraphNode, type GraphRelationship } from '@ekg/shared';
import { SearchTextRepository, type SearchTextRow } from '@ekg/storage';

const MAX_BODY_CHARS = 8 * 1024;

export interface SearchIndexServiceOptions {
  readonly dbPath: string;
}

export class SearchIndexService {
  private readonly repo: SearchTextRepository;
  private readonly logger: Logger;

  constructor(opts: SearchIndexServiceOptions) {
    this.repo = new SearchTextRepository(opts.dbPath);
    this.logger = createLogger({ service: 'search-index-service' });
  }

  /** Tests can inject an existing repo. */
  static withRepository(repo: SearchTextRepository): SearchIndexService {
    const svc = Object.create(SearchIndexService.prototype) as SearchIndexService;
    Object.assign(svc, { repo, logger: createLogger({ service: 'search-index-service' }) });
    return svc;
  }

  getRepository(): SearchTextRepository {
    return this.repo;
  }

  async indexFromExtraction(
    repoUrl: string,
    repoLocalPath: string,
    nodes: readonly GraphNode[],
    relationships: readonly GraphRelationship[],
  ): Promise<void> {
    try {
      const rows = await this.buildRows(repoUrl, repoLocalPath, nodes, relationships);
      if (rows.length === 0) {
        this.logger.info({ repoUrl }, 'No BM25-indexable nodes in extraction');
        return;
      }
      this.repo.index(rows);
      this.logger.info({ repoUrl, count: rows.length }, 'BM25 index updated');
    } catch (err) {
      this.logger.warn({ repoUrl, err: errMsg(err) }, 'BM25 indexing failed (non-fatal)');
    }
  }

  deleteByRepo(repoUrl: string): void {
    try {
      this.repo.deleteByRepo(repoUrl);
    } catch (err) {
      this.logger.warn({ repoUrl, err: errMsg(err) }, 'BM25 delete-by-repo failed');
    }
  }

  close(): void {
    this.repo.close();
  }

  private async buildRows(
    repoUrl: string,
    repoLocalPath: string,
    nodes: readonly GraphNode[],
    relationships: readonly GraphRelationship[],
  ): Promise<readonly SearchTextRow[]> {
    const columnsByTable = indexColumns(nodes, relationships);
    const out: SearchTextRow[] = [];

    for (const node of nodes) {
      const row = await this.nodeToRow(node, repoUrl, repoLocalPath, columnsByTable);
      if (row) out.push(row);
    }
    return out;
  }

  private async nodeToRow(
    node: GraphNode,
    repoUrl: string,
    repoLocalPath: string,
    columnsByTable: ReadonlyMap<string, { name: string; type: string }[]>,
  ): Promise<SearchTextRow | undefined> {
    switch (node.label) {
      case 'Function': return this.functionRow(node, repoUrl, repoLocalPath);
      case 'Doc': return this.docRow(node, repoUrl);
      case 'Table': return this.tableRow(node, repoUrl, columnsByTable);
      case 'API': return this.apiRow(node, repoUrl);
      default: return undefined;
    }
  }

  private async functionRow(node: GraphNode, repoUrl: string, repoLocalPath: string): Promise<SearchTextRow> {
    const props = node.properties as {
      signature?: string; docComment?: string; filePath?: string; lineStart?: number; lineEnd?: number;
    };
    let body = '';
    if (props.filePath && props.lineStart && props.lineEnd) {
      try {
        body = await readBodyLines(join(repoLocalPath, props.filePath), props.lineStart, props.lineEnd);
      } catch {
        body = '';
      }
    }
    const text = [props.signature ?? node.name, props.docComment ?? '', body].filter(Boolean).join('\n\n');
    return {
      label: 'Function',
      nodeId: node.id,
      repoUrl,
      name: node.name,
      path: props.filePath ?? '',
      body: truncate(text),
    };
  }

  private docRow(node: GraphNode, repoUrl: string): SearchTextRow {
    const props = node.properties as { title?: string; rawText?: string; filePath?: string };
    return {
      label: 'Doc',
      nodeId: node.id,
      repoUrl,
      name: props.title ?? node.name,
      path: props.filePath ?? '',
      body: truncate(props.rawText ?? ''),
    };
  }

  private tableRow(
    node: GraphNode,
    repoUrl: string,
    columnsByTable: ReadonlyMap<string, { name: string; type: string }[]>,
  ): SearchTextRow {
    const props = node.properties as { name?: string; raw?: string; filePath?: string };
    const cols = (columnsByTable.get(node.id) ?? []).map((c) => `${c.name}:${c.type}`).join(', ');
    return {
      label: 'Table',
      nodeId: node.id,
      repoUrl,
      name: props.name ?? node.name,
      path: props.filePath ?? '',
      body: truncate([`TABLE ${props.name ?? node.name}`, `COLUMNS: ${cols}`, props.raw ?? ''].filter(Boolean).join('\n')),
    };
  }

  private apiRow(node: GraphNode, repoUrl: string): SearchTextRow {
    const props = node.properties as {
      method?: string; path?: string; summary?: string; operationId?: string; filePath?: string;
    };
    return {
      label: 'API',
      nodeId: node.id,
      repoUrl,
      name: `${(props.method ?? 'GET').toUpperCase()} ${props.path ?? node.name}`,
      path: props.filePath ?? '',
      body: truncate([props.operationId ?? '', props.summary ?? ''].filter(Boolean).join('\n')),
    };
  }
}

function indexColumns(
  nodes: readonly GraphNode[],
  relationships: readonly GraphRelationship[],
): ReadonlyMap<string, { name: string; type: string }[]> {
  const columnNodeById = new Map<string, GraphNode>();
  for (const n of nodes) if (n.label === 'Column') columnNodeById.set(n.id, n);
  const out = new Map<string, { name: string; type: string }[]>();
  for (const rel of relationships) {
    if (rel.type !== 'HAS') continue;
    const col = columnNodeById.get(rel.targetId);
    if (!col) continue;
    const props = col.properties as { name?: string; type?: string };
    const list = out.get(rel.sourceId) ?? [];
    list.push({ name: props.name ?? col.name, type: props.type ?? 'unknown' });
    out.set(rel.sourceId, list);
  }
  return out;
}

async function readBodyLines(absolutePath: string, lineStart: number, lineEnd: number): Promise<string> {
  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(0, lineStart - 1);
  const end = Math.min(lines.length, lineEnd);
  return lines.slice(start, end).join('\n');
}

function truncate(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
