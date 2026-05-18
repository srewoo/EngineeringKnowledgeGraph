/**
 * SchemaPythonExtractor — deterministic regex extractor for the two
 * dominant Python ORMs:
 *
 *  - SQLAlchemy declarative — `class X(Base): __tablename__ = "x"; col = Column(...)`
 *  - SQLAlchemy core         — `Table("x", metadata, Column("col", Type, ...))`
 *  - Django                  — `class X(models.Model): col = models.CharField(...)`
 *
 * Emits Table + Column nodes and HAS edges — same shape as the Prisma /
 * TS ORM extractors so downstream emission code is uniform.
 */

import type { GraphNode, GraphRelationship } from '@ekg/shared';

export interface PythonOrmExtractionResult {
  readonly tables: readonly GraphNode[];
  readonly columns: readonly GraphNode[];
  readonly relations: readonly GraphRelationship[];
}

const EMPTY: PythonOrmExtractionResult = { tables: [], columns: [], relations: [] };

const SQLA_CLASS_RE =
  /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/gm;
const SQLA_TABLENAME_RE =
  /^[ \t]+__tablename__\s*=\s*["']([^"']+)["']/m;
const SQLA_FIELD_RE =
  /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][A-Za-z0-9_.\[\], ]*\s*)?=\s*(?:mapped_column|Column|sa\.Column)\s*\(([\s\S]*?)\)\s*$/gm;
const SQLA_TABLE_FN_RE =
  /\bTable\s*\(\s*["']([^"']+)["']\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*,([\s\S]*?)\)\s*$/gm;
const SQLA_TABLE_FN_COL_RE =
  /Column\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)([^)]*)\)/g;

const DJANGO_CLASS_RE =
  /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*models\.Model[^)]*)\)\s*:/gm;
const DJANGO_FIELD_RE =
  /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*models\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*$/gm;
const DJANGO_META_TABLE_RE =
  /class\s+Meta[^:]*:[\s\S]*?db_table\s*=\s*["']([^"']+)["']/;

export class SchemaPythonExtractor {
  static handles(content: string): boolean {
    return (
      content.includes('Column(') ||
      content.includes('mapped_column(') ||
      content.includes('Table(') ||
      content.includes('models.Model')
    );
  }

  extract(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): PythonOrmExtractionResult {
    if (!SchemaPythonExtractor.handles(content)) return EMPTY;
    const tables: GraphNode[] = [];
    const columns: GraphNode[] = [];
    const relations: GraphRelationship[] = [];

    extractSqlaDeclarative(content, relativePath, repoUrl, tables, columns, relations);
    extractSqlaTableFn(content, relativePath, repoUrl, tables, columns, relations);
    extractDjango(content, relativePath, repoUrl, tables, columns, relations);

    return { tables, columns, relations };
  }
}

function extractSqlaDeclarative(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  SQLA_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQLA_CLASS_RE.exec(content))) {
    const className = m[1]!;
    const bases = m[2] ?? '';
    // Heuristic: SQLAlchemy declarative bases either say "Base" or end with "Model".
    if (!/\bBase\b|Model$|DeclarativeBase/.test(bases)) continue;
    if (/models\.Model/.test(bases)) continue; // Django handled separately

    const blockStart = m.index + m[0].length;
    const blockEnd = pythonBlockEnd(content, blockStart);
    const block = content.slice(blockStart, blockEnd);

    // Skip placeholder bases ("class Base(DeclarativeBase): pass") and other
    // classes that don't actually declare columns.
    if (!/__tablename__|Column\s*\(|mapped_column\s*\(/.test(block)) continue;

    const tnMatch = SQLA_TABLENAME_RE.exec(block);
    const tableName = tnMatch?.[1] ?? className;
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
        orm: 'sqlalchemy',
      },
    });

    SQLA_FIELD_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = SQLA_FIELD_RE.exec(block))) {
      const fieldName = fm[1]!;
      const args = fm[2] ?? '';
      // First positional arg is the SQLA type (`Integer`, `String(50)`, etc.) —
      // unless the first arg is a string column name.
      const firstArg = args.split(',')[0]?.trim() ?? '';
      const colType = /^["']/.test(firstArg)
        ? (args.split(',')[1]?.trim() ?? 'unknown')
        : firstArg || 'unknown';
      const isPrimary = /\bprimary_key\s*=\s*True\b/.test(args);
      const nullable = !/\bnullable\s*=\s*False\b/.test(args);
      const isUnique = /\bunique\s*=\s*True\b/.test(args);
      pushColumn(tableId, fieldName, colType, nullable, isPrimary, isUnique, 'sqlalchemy', columns, relations, lineOf(content, blockStart + (fm.index ?? 0)));
    }
  }
}

function extractSqlaTableFn(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  SQLA_TABLE_FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQLA_TABLE_FN_RE.exec(content))) {
    const tableName = m[1]!;
    const tableId = `table:${repoUrl}:${tableName}`;
    if (tables.some((t) => t.id === tableId)) continue;
    tables.push({
      id: tableId,
      label: 'Table',
      name: tableName,
      properties: {
        name: tableName,
        repoUrl,
        filePath: relativePath,
        sourceLine: lineOf(content, m.index),
        orm: 'sqlalchemy-core',
      },
    });
    const body = m[2] ?? '';
    SQLA_TABLE_FN_COL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = SQLA_TABLE_FN_COL_RE.exec(body))) {
      const fieldName = cm[1]!;
      const colType = cm[2] ?? 'unknown';
      const rest = cm[3] ?? '';
      const isPrimary = /\bprimary_key\s*=\s*True\b/.test(rest);
      const nullable = !/\bnullable\s*=\s*False\b/.test(rest);
      const isUnique = /\bunique\s*=\s*True\b/.test(rest);
      pushColumn(tableId, fieldName, colType, nullable, isPrimary, isUnique, 'sqlalchemy-core', columns, relations, lineOf(content, m.index));
    }
  }
}

function extractDjango(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  DJANGO_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DJANGO_CLASS_RE.exec(content))) {
    const className = m[1]!;
    const blockStart = m.index + m[0].length;
    const blockEnd = pythonBlockEnd(content, blockStart);
    const block = content.slice(blockStart, blockEnd);

    const metaMatch = DJANGO_META_TABLE_RE.exec(block);
    const tableName = metaMatch?.[1] ?? className;
    const tableId = `table:${repoUrl}:${tableName}`;
    if (tables.some((t) => t.id === tableId)) continue;
    tables.push({
      id: tableId,
      label: 'Table',
      name: tableName,
      properties: {
        name: tableName,
        repoUrl,
        filePath: relativePath,
        sourceLine: lineOf(content, m.index),
        orm: 'django',
      },
    });

    DJANGO_FIELD_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = DJANGO_FIELD_RE.exec(block))) {
      const fieldName = fm[1]!;
      // Skip Meta inner-class assignments and managers.
      if (fieldName === 'objects' || fieldName.startsWith('_')) continue;
      const fieldType = fm[2]!;
      const args = fm[3] ?? '';
      const isPrimary = /\bprimary_key\s*=\s*True\b/.test(args);
      const nullable = /\bnull\s*=\s*True\b/.test(args);
      const isUnique = /\bunique\s*=\s*True\b/.test(args);
      pushColumn(tableId, fieldName, fieldType, nullable, isPrimary, isUnique, 'django', columns, relations, lineOf(content, blockStart + (fm.index ?? 0)));
    }
  }
}

function pushColumn(
  tableId: string,
  name: string,
  type: string,
  nullable: boolean,
  isPrimary: boolean,
  isUnique: boolean,
  orm: string,
  columns: GraphNode[],
  relations: GraphRelationship[],
  sourceLine: number,
): void {
  const colId = `${tableId}:${name}`;
  columns.push({
    id: colId,
    label: 'Column',
    name,
    properties: { tableId, name, type, nullable, isPrimary, isUnique, orm },
  });
  relations.push({
    type: 'HAS',
    sourceId: tableId,
    targetId: colId,
    confidence: 'HIGH',
    properties: { sourceLine },
  });
}

/**
 * Returns the index of the first character at the same or shallower indent
 * level as the class header — i.e. the end of the class body. Falls back to
 * end-of-content if no dedent is found. Tabs are treated as one indent unit.
 */
function pythonBlockEnd(content: string, blockStart: number): number {
  // Class body starts on a new line; scan forward until a non-blank line at
  // indent 0 (or another `class`/`def` at column 0) is hit.
  const after = content.slice(blockStart);
  const re = /^(?=[^\s\n])|\n(?=class\s|def\s)/gm;
  re.lastIndex = 1; // skip the very first char if it happens to match
  const m = re.exec(after);
  if (!m) return content.length;
  return blockStart + m.index;
}

function lineOf(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}
