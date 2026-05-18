/**
 * SchemaTsOrmExtractor — deterministic regex extractor for the three most
 * common TypeScript ORMs:
 *
 *  - TypeORM     — `@Entity(...)` class with `@Column(...)`/`@PrimaryColumn`/
 *                  `@PrimaryGeneratedColumn` decorated fields.
 *  - Drizzle     — `pgTable("name", { col: type(...).primaryKey() })` (and
 *                  `mysqlTable` / `sqliteTable`).
 *  - Sequelize   — `sequelize.define("name", { col: { type, primaryKey } })`
 *                  AND `class X extends Model { ... }; X.init({ ... }, ...)`.
 *
 * Emits Table + Column nodes and HAS edges, mirroring the Prisma extractor's
 * shape so downstream callers can stay uniform. Runs over raw source content,
 * no ts-morph dependency — these patterns are mechanical enough that regex
 * gives high precision without the AST cost.
 */

import type { GraphNode, GraphRelationship } from '@ekg/shared';

export interface TsOrmExtractionResult {
  readonly tables: readonly GraphNode[];
  readonly columns: readonly GraphNode[];
  readonly relations: readonly GraphRelationship[];
}

const EMPTY: TsOrmExtractionResult = { tables: [], columns: [], relations: [] };

export class SchemaTsOrmExtractor {
  /** True if this file *might* contain a supported ORM. Cheap content sniff. */
  static handles(content: string): boolean {
    return (
      content.includes('@Entity') ||
      content.includes('pgTable(') ||
      content.includes('mysqlTable(') ||
      content.includes('sqliteTable(') ||
      content.includes('sequelize.define') ||
      /\bextends\s+Model\b/.test(content)
    );
  }

  extract(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): TsOrmExtractionResult {
    if (!SchemaTsOrmExtractor.handles(content)) return EMPTY;

    const tables: GraphNode[] = [];
    const columns: GraphNode[] = [];
    const relations: GraphRelationship[] = [];

    extractTypeOrm(content, relativePath, repoUrl, tables, columns, relations);
    extractDrizzle(content, relativePath, repoUrl, tables, columns, relations);
    extractSequelize(content, relativePath, repoUrl, tables, columns, relations);

    return { tables, columns, relations };
  }
}

// --- TypeORM ---

const TYPEORM_ENTITY_RE =
  /@Entity\s*\(\s*(?:["'`]([^"'`]+)["'`]|\{[^}]*name\s*:\s*["'`]([^"'`]+)["'`][^}]*\}|)?\s*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g;

const TYPEORM_COLUMN_DECORATOR_RE =
  /@(Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn)\s*(\([^)]*\))?\s*(?:[\s\S]{0,200}?)\b([A-Za-z_][A-Za-z0-9_]*)\s*[!?]?\s*:/g;

function extractTypeOrm(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  TYPEORM_ENTITY_RE.lastIndex = 0;
  const entities: Array<{ name: string; tableName: string; bodyStart: number; bodyEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = TYPEORM_ENTITY_RE.exec(content))) {
    const explicit = m[1] ?? m[2];
    const className = m[3]!;
    const bodyStart = findOpeningBrace(content, m.index + m[0].length);
    if (bodyStart < 0) continue;
    const bodyEnd = matchBrace(content, bodyStart);
    if (bodyEnd < 0) continue;
    entities.push({
      name: className,
      tableName: explicit ?? className,
      bodyStart,
      bodyEnd,
    });
  }

  for (const ent of entities) {
    const tableId = `table:${repoUrl}:${ent.tableName}`;
    tables.push({
      id: tableId,
      label: 'Table',
      name: ent.tableName,
      properties: {
        name: ent.tableName,
        repoUrl,
        filePath: relativePath,
        sourceLine: lineOf(content, ent.bodyStart),
        orm: 'typeorm',
      },
    });
    const body = content.slice(ent.bodyStart, ent.bodyEnd + 1);
    const seen = new Set<string>();
    let dm: RegExpExecArray | null;
    TYPEORM_COLUMN_DECORATOR_RE.lastIndex = 0;
    while ((dm = TYPEORM_COLUMN_DECORATOR_RE.exec(body))) {
      const decorator = dm[1]!;
      const args = dm[2] ?? '';
      const fieldName = dm[3]!;
      if (seen.has(fieldName)) continue;
      seen.add(fieldName);
      const isPrimary = decorator.startsWith('Primary');
      const nullable = /\bnullable\s*:\s*true\b/.test(args);
      const isUnique = /\bunique\s*:\s*true\b/.test(args);
      const typeMatch = /\btype\s*:\s*["'`]([^"'`]+)["'`]/.exec(args);
      const colId = `${tableId}:${fieldName}`;
      columns.push({
        id: colId,
        label: 'Column',
        name: fieldName,
        properties: {
          tableId,
          name: fieldName,
          type: typeMatch?.[1] ?? 'unknown',
          nullable,
          isPrimary,
          isUnique,
          orm: 'typeorm',
        },
      });
      relations.push({
        type: 'HAS',
        sourceId: tableId,
        targetId: colId,
        confidence: 'HIGH',
        properties: {
          sourceLine: lineOf(content, ent.bodyStart + (dm.index ?? 0)),
          decorator,
        },
      });
    }
  }
}

// --- Drizzle ---

const DRIZZLE_TABLE_RE =
  /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(pgTable|mysqlTable|sqliteTable)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/g;

// Matches a column definition: `colName: type(...)...,`
const DRIZZLE_COLUMN_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*((?:\.[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\))*)\s*[,\n]/gm;

function extractDrizzle(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  DRIZZLE_TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DRIZZLE_TABLE_RE.exec(content))) {
    const tableName = m[3]!;
    const objStart = content.indexOf('{', m.index + m[0].length - 1);
    if (objStart < 0) continue;
    const objEnd = matchBrace(content, objStart);
    if (objEnd < 0) continue;
    const body = content.slice(objStart + 1, objEnd);
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
        orm: 'drizzle',
        flavor: m[2],
      },
    });

    DRIZZLE_COLUMN_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = DRIZZLE_COLUMN_RE.exec(body))) {
      const fieldName = cm[1]!;
      const colType = cm[2]!;
      const chained = cm[4] ?? '';
      const colId = `${tableId}:${fieldName}`;
      const isPrimary = /\.primaryKey\(/.test(chained);
      const isUnique = /\.unique\(/.test(chained);
      const isNotNull = /\.notNull\(/.test(chained);
      const hasDefault = /\.default\(/.test(chained) || /\.defaultNow\(/.test(chained);
      columns.push({
        id: colId,
        label: 'Column',
        name: fieldName,
        properties: {
          tableId,
          name: fieldName,
          type: colType,
          nullable: !isNotNull && !isPrimary,
          isPrimary,
          isUnique,
          ...(hasDefault ? { hasDefault: true } : {}),
          orm: 'drizzle',
        },
      });
      relations.push({
        type: 'HAS',
        sourceId: tableId,
        targetId: colId,
        confidence: 'HIGH',
        properties: { sourceLine: lineOf(content, objStart + (cm.index ?? 0)) },
      });
    }
  }
}

// --- Sequelize ---

const SEQUELIZE_DEFINE_RE =
  /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:sequelize|db)\.define\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/g;

const SEQUELIZE_INIT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)\.init\s*\(\s*\{/g;

// Captures: `colName: { ...DataTypes.X..., primaryKey: true, ... },`
// or simpler `colName: DataTypes.X,`
const SEQUELIZE_FIELD_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\{[^{}]*\}|DataTypes\.[A-Za-z]+(?:\([^)]*\))?)\s*[,\n]/gm;

function extractSequelize(
  content: string,
  relativePath: string,
  repoUrl: string,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  // sequelize.define("Name", { ... })
  SEQUELIZE_DEFINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEQUELIZE_DEFINE_RE.exec(content))) {
    const tableName = m[1]!;
    const objStart = content.indexOf('{', m.index + m[0].length - 1);
    if (objStart < 0) continue;
    const objEnd = matchBrace(content, objStart);
    if (objEnd < 0) continue;
    pushSequelizeTable(content, repoUrl, relativePath, tableName, objStart, objEnd, tables, columns, relations);
  }

  // class Foo extends Model { } ; Foo.init({ ... }, { ...sequelize... })
  SEQUELIZE_INIT_RE.lastIndex = 0;
  while ((m = SEQUELIZE_INIT_RE.exec(content))) {
    const className = m[1]!;
    // Confirm it's a Sequelize Model (cheap heuristic).
    const classRe = new RegExp(`class\\s+${className}\\s+extends\\s+(?:[A-Za-z_$][A-Za-z0-9_$.]*\\.)?Model\\b`);
    if (!classRe.test(content)) continue;
    const objStart = content.indexOf('{', m.index + m[0].length - 1);
    if (objStart < 0) continue;
    const objEnd = matchBrace(content, objStart);
    if (objEnd < 0) continue;
    pushSequelizeTable(content, repoUrl, relativePath, className, objStart, objEnd, tables, columns, relations);
  }
}

function pushSequelizeTable(
  content: string,
  repoUrl: string,
  relativePath: string,
  tableName: string,
  objStart: number,
  objEnd: number,
  tables: GraphNode[],
  columns: GraphNode[],
  relations: GraphRelationship[],
): void {
  const tableId = `table:${repoUrl}:${tableName}`;
  if (tables.some((t) => t.id === tableId)) return;
  tables.push({
    id: tableId,
    label: 'Table',
    name: tableName,
    properties: {
      name: tableName,
      repoUrl,
      filePath: relativePath,
      sourceLine: lineOf(content, objStart),
      orm: 'sequelize',
    },
  });
  const body = content.slice(objStart + 1, objEnd);
  SEQUELIZE_FIELD_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = SEQUELIZE_FIELD_RE.exec(body))) {
    const fieldName = cm[1]!;
    const value = cm[2]!;
    const isPrimary = /primaryKey\s*:\s*true/.test(value);
    const allowNull = /allowNull\s*:\s*false/.test(value) ? false : !/allowNull\s*:\s*true/.test(value);
    const isUnique = /unique\s*:\s*true/.test(value);
    const typeMatch = /DataTypes\.([A-Za-z]+)/.exec(value);
    const colId = `${tableId}:${fieldName}`;
    columns.push({
      id: colId,
      label: 'Column',
      name: fieldName,
      properties: {
        tableId,
        name: fieldName,
        type: typeMatch?.[1] ?? 'unknown',
        nullable: allowNull,
        isPrimary,
        isUnique,
        orm: 'sequelize',
      },
    });
    relations.push({
      type: 'HAS',
      sourceId: tableId,
      targetId: colId,
      confidence: 'HIGH',
      properties: { sourceLine: lineOf(content, objStart + (cm.index ?? 0)) },
    });
  }
}

// --- helpers ---

function findOpeningBrace(content: string, from: number): number {
  for (let i = from; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') return i;
    if (ch === ';') return -1;
  }
  return -1;
}

function matchBrace(content: string, openIdx: number): number {
  if (content[openIdx] !== '{') return -1;
  let depth = 0;
  let inStr: '"' | "'" | '`' | undefined;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}
