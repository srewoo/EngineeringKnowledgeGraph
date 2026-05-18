/**
 * SchemaSqlExtractor — deterministic regex parser for raw SQL DDL files and
 * Liquibase changelogs.
 *
 * Sources covered:
 *  - Plain `.sql` migration files (Flyway-style names recognised: `V1__init.sql`,
 *    `R__view.sql`, `U2__rollback.sql`).
 *  - Liquibase YAML / JSON / XML changelogs (XML/YAML parsed line-wise; we
 *    extract `createTable` / `addColumn` / `dropTable` etc.).
 *
 * Emits:
 *  - Migration nodes (one per file).
 *  - Table + Column nodes from CREATE TABLE statements.
 *  - HAS edges for columns.
 *  - ALTERS edges from Migration → Table for ALTER/DROP/ADD changes.
 */

import { basename } from 'node:path';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

export interface SqlExtractionResult {
  readonly migrations: readonly GraphNode[];
  readonly tables: readonly GraphNode[];
  readonly columns: readonly GraphNode[];
  readonly relations: readonly GraphRelationship[];
}

const EMPTY: SqlExtractionResult = {
  migrations: [],
  tables: [],
  columns: [],
  relations: [],
};

const FLYWAY_FILE_RE = /^([VUR])(\d+(?:[._]\d+)*)__(.+)\.sql$/i;
const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][\w.]*)["`]?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;
const ALTER_TABLE_RE =
  /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w.]*)["`]?/gi;
const DROP_TABLE_RE =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][\w.]*)["`]?/gi;

const LIQUIBASE_TABLE_RE =
  /<createTable[^>]*\btableName\s*=\s*["']([^"']+)["']/g;
const LIQUIBASE_COLUMN_RE =
  /<column[^>]*\bname\s*=\s*["']([^"']+)["'][^/>]*\btype\s*=\s*["']([^"']+)["']([^/>]*)/g;
const LIQUIBASE_ALTER_RE =
  /<(?:addColumn|dropColumn|addPrimaryKey|addForeignKeyConstraint|dropTable|renameColumn|modifyDataType)[^>]*\btableName\s*=\s*["']([^"']+)["']/g;

export class SchemaSqlExtractor {
  static handles(relativePath: string): boolean {
    const base = basename(relativePath).toLowerCase();
    if (base.endsWith('.sql')) return true;
    // Liquibase changelog naming patterns are loose; route by content sniff
    // in the pipeline rather than name. Here we say "yes" for changelog-ish
    // names so the pipeline can decide.
    return /(changelog|liquibase|flyway).*\.(xml|ya?ml|json)$/.test(base);
  }

  /** Quick content-sniff for Liquibase XML/YAML/JSON changelogs. */
  static isLiquibase(content: string): boolean {
    return (
      content.includes('<databaseChangeLog') ||
      content.includes('<changeSet') ||
      /\bchangeSet\s*:/.test(content) ||
      content.includes('"databaseChangeLog"')
    );
  }

  extract(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): SqlExtractionResult {
    const base = basename(relativePath);
    if (base.toLowerCase().endsWith('.sql')) {
      return this.extractSql(content, relativePath, repoUrl);
    }
    if (SchemaSqlExtractor.isLiquibase(content)) {
      return this.extractLiquibase(content, relativePath, repoUrl);
    }
    return EMPTY;
  }

  private extractSql(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): SqlExtractionResult {
    const tables: GraphNode[] = [];
    const columns: GraphNode[] = [];
    const relations: GraphRelationship[] = [];

    const migrationId = `migration:${repoUrl}:${relativePath}`;
    const flyway = FLYWAY_FILE_RE.exec(basename(relativePath));
    const migrationNode: GraphNode = {
      id: migrationId,
      label: 'Migration',
      name: basename(relativePath),
      properties: {
        name: basename(relativePath),
        filePath: relativePath,
        repoUrl,
        ...(flyway
          ? {
              flywayKind: flyway[1]?.toUpperCase(),
              flywayVersion: flyway[2],
              flywayDescription: flyway[3]?.replace(/_/g, ' '),
            }
          : {}),
        format: 'sql',
      },
    };

    // Collect CREATE TABLE
    CREATE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let touchedAny = false;
    while ((m = CREATE_TABLE_RE.exec(content))) {
      touchedAny = true;
      const tableName = stripSchema(m[1]!);
      const cols = parseCreateTableBody(m[2] ?? '');
      const tableId = `table:${repoUrl}:${tableName}`;
      tables.push({
        id: tableId,
        label: 'Table',
        name: tableName,
        properties: {
          name: tableName,
          repoUrl,
          filePath: relativePath,
          sourceLine: lineOf(content, m.index),
          orm: 'sql-ddl',
        },
      });
      relations.push({
        type: 'ALTERS',
        sourceId: migrationId,
        targetId: tableId,
        confidence: 'HIGH',
        properties: { kind: 'CREATE' },
      });
      for (const c of cols) {
        const colId = `${tableId}:${c.name}`;
        columns.push({
          id: colId,
          label: 'Column',
          name: c.name,
          properties: {
            tableId,
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            isPrimary: c.isPrimary,
            isUnique: c.isUnique,
            orm: 'sql-ddl',
            ...(c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
          },
        });
        relations.push({
          type: 'HAS',
          sourceId: tableId,
          targetId: colId,
          confidence: 'HIGH',
          properties: {},
        });
      }
    }

    // ALTER TABLE / DROP TABLE → ALTERS edges (no Table node created — we
    // assume CREATE happened in some migration).
    ALTER_TABLE_RE.lastIndex = 0;
    while ((m = ALTER_TABLE_RE.exec(content))) {
      const t = stripSchema(m[1]!);
      relations.push({
        type: 'ALTERS',
        sourceId: migrationId,
        targetId: `table:${repoUrl}:${t}`,
        confidence: 'HIGH',
        properties: { kind: 'ALTER' },
      });
      touchedAny = true;
    }
    DROP_TABLE_RE.lastIndex = 0;
    while ((m = DROP_TABLE_RE.exec(content))) {
      const t = stripSchema(m[1]!);
      relations.push({
        type: 'ALTERS',
        sourceId: migrationId,
        targetId: `table:${repoUrl}:${t}`,
        confidence: 'HIGH',
        properties: { kind: 'DROP' },
      });
      touchedAny = true;
    }

    if (!touchedAny) return EMPTY;
    return { migrations: [migrationNode], tables, columns, relations };
  }

  private extractLiquibase(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): SqlExtractionResult {
    const tables: GraphNode[] = [];
    const columns: GraphNode[] = [];
    const relations: GraphRelationship[] = [];

    const migrationId = `migration:${repoUrl}:${relativePath}`;
    const migrationNode: GraphNode = {
      id: migrationId,
      label: 'Migration',
      name: basename(relativePath),
      properties: {
        name: basename(relativePath),
        filePath: relativePath,
        repoUrl,
        format: 'liquibase',
      },
    };

    // createTable + columns
    LIQUIBASE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let touchedAny = false;
    const tableSpans: Array<{ name: string; start: number; end: number }> = [];
    while ((m = LIQUIBASE_TABLE_RE.exec(content))) {
      const name = m[1]!;
      const open = m.index;
      const closeRe = /<\/createTable>/g;
      closeRe.lastIndex = open;
      const closeMatch = closeRe.exec(content);
      const end = closeMatch ? closeMatch.index : open + 200;
      tableSpans.push({ name, start: open, end });
      touchedAny = true;
      const tableId = `table:${repoUrl}:${name}`;
      tables.push({
        id: tableId,
        label: 'Table',
        name,
        properties: {
          name,
          repoUrl,
          filePath: relativePath,
          sourceLine: lineOf(content, open),
          orm: 'liquibase',
        },
      });
      relations.push({
        type: 'ALTERS',
        sourceId: migrationId,
        targetId: tableId,
        confidence: 'HIGH',
        properties: { kind: 'CREATE' },
      });

      const body = content.slice(open, end);
      LIQUIBASE_COLUMN_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = LIQUIBASE_COLUMN_RE.exec(body))) {
        const colName = cm[1]!;
        const colType = cm[2]!;
        const rest = cm[3] ?? '';
        const isPrimary = /\bprimaryKey\s*=\s*["']true["']/.test(rest) || /<constraints[^>]*primaryKey\s*=\s*["']true["']/.test(body.slice(cm.index, Math.min(body.length, cm.index + 400)));
        const nullable = !/\bnullable\s*=\s*["']false["']/.test(rest) && !/<constraints[^>]*nullable\s*=\s*["']false["']/.test(body.slice(cm.index, Math.min(body.length, cm.index + 400)));
        const isUnique = /\bunique\s*=\s*["']true["']/.test(rest) || /<constraints[^>]*unique\s*=\s*["']true["']/.test(body.slice(cm.index, Math.min(body.length, cm.index + 400)));
        const colId = `${tableId}:${colName}`;
        columns.push({
          id: colId,
          label: 'Column',
          name: colName,
          properties: {
            tableId,
            name: colName,
            type: colType,
            nullable,
            isPrimary,
            isUnique,
            orm: 'liquibase',
          },
        });
        relations.push({
          type: 'HAS',
          sourceId: tableId,
          targetId: colId,
          confidence: 'HIGH',
          properties: {},
        });
      }
    }

    LIQUIBASE_ALTER_RE.lastIndex = 0;
    while ((m = LIQUIBASE_ALTER_RE.exec(content))) {
      const t = m[1]!;
      // Skip if already covered as createTable.
      if (tableSpans.some((s) => s.name === t && m!.index >= s.start && m!.index <= s.end)) {
        continue;
      }
      touchedAny = true;
      relations.push({
        type: 'ALTERS',
        sourceId: migrationId,
        targetId: `table:${repoUrl}:${t}`,
        confidence: 'HIGH',
        properties: { kind: 'ALTER' },
      });
    }

    if (!touchedAny) return EMPTY;
    return { migrations: [migrationNode], tables, columns, relations };
  }
}

interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  isUnique: boolean;
  defaultValue?: string;
}

function parseCreateTableBody(body: string): ParsedColumn[] {
  // Split on top-level commas (skip parens).
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());

  const cols: ParsedColumn[] = [];
  const tablePks = new Set<string>();
  for (const part of parts) {
    const upper = part.toUpperCase();
    // Table-level PRIMARY KEY (id, foo)
    if (upper.startsWith('PRIMARY KEY')) {
      const m = /\(([^)]+)\)/.exec(part);
      if (m) {
        for (const n of m[1]!.split(',').map((s) => s.trim().replace(/^["`]|["`]$/g, ''))) {
          tablePks.add(n);
        }
      }
      continue;
    }
    if (upper.startsWith('CONSTRAINT') || upper.startsWith('FOREIGN KEY') || upper.startsWith('UNIQUE') || upper.startsWith('CHECK') || upper.startsWith('INDEX') || upper.startsWith('KEY ')) {
      continue;
    }
    const colMatch = /^["`]?([A-Za-z_][\w]*)["`]?\s+([A-Za-z_][\w]*(?:\s*\([^)]*\))?)(.*)$/.exec(part);
    if (!colMatch) continue;
    const name = colMatch[1]!;
    const type = colMatch[2]!.trim();
    const tail = (colMatch[3] ?? '').toUpperCase();
    const isPrimary = /\bPRIMARY\s+KEY\b/.test(tail);
    const nullable = !/\bNOT\s+NULL\b/.test(tail) && !isPrimary;
    const isUnique = /\bUNIQUE\b/.test(tail);
    const defMatch = /\bDEFAULT\s+([^\s,]+(?:\([^)]*\))?)/i.exec(colMatch[3] ?? '');
    cols.push({
      name,
      type,
      nullable,
      isPrimary,
      isUnique,
      ...(defMatch ? { defaultValue: defMatch[1]! } : {}),
    });
  }
  // Apply table-level PK to columns.
  for (const c of cols) {
    if (tablePks.has(c.name)) {
      c.isPrimary = true;
      c.nullable = false;
    }
  }
  return cols;
}

function stripSchema(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function lineOf(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}
