/**
 * SchemaPrismaExtractor — pure deterministic parser for `schema.prisma` files.
 *
 * Line-based regex parser (no `@prisma/internals`). Emits Table, Column,
 * Migration nodes (Migration is reserved here for callers parsing the
 * `migrations/` folder) plus HAS (Table→Column) and RELATES_TO (Table→Table)
 * edges. Confidence is HIGH for explicit attrs, MEDIUM for inferred relations.
 *
 * Scope: model blocks, field attributes (`@id`, `@unique`, `@default`, `@map`,
 * `@relation`), block-level attrs (`@@id`, `@@unique`, `@@index`, `@@map`).
 */
import { basename } from 'node:path';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

export interface PrismaExtractionResult {
  readonly tables: readonly GraphNode[];
  readonly columns: readonly GraphNode[];
  readonly indexes: readonly PrismaIndex[];
  readonly relations: readonly GraphRelationship[];
}

export interface PrismaIndex {
  readonly tableId: string;
  readonly tableName: string;
  readonly fields: readonly string[];
  readonly kind: 'index' | 'unique' | 'id';
}

interface ParsedField {
  readonly name: string;
  readonly type: string;          // base type (model name or scalar)
  readonly nullable: boolean;
  readonly isList: boolean;
  readonly attrs: string;         // raw remaining attribute string
  readonly line: number;
}

const MODEL_HEADER_RE = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/;
const FIELD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/;
const BLOCK_ATTR_RE = /^\s*(@@[a-zA-Z]+)\s*\(([^)]*)\)\s*$/;
const MAP_ATTR_RE = /@map\(\s*"([^"]+)"\s*\)/;
// `@default(...)` — supports nested parens (e.g. `now()`, `dbgenerated("...")`).
const DEFAULT_ATTR_START_RE = /@default\(/;
const RELATION_FIELDS_RE = /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*\)/;
const FIELDS_LIST_RE = /\[([^\]]*)\]/;

const SCALAR_TYPES = new Set([
  'String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean',
  'DateTime', 'Json', 'Bytes',
]);

export class SchemaPrismaExtractor {
  /** True if filename is `schema.prisma` (case-sensitive basename). */
  static handles(filePath: string): boolean {
    return basename(filePath) === 'schema.prisma';
  }

  extract(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): PrismaExtractionResult {
    const lines = content.split(/\r?\n/);
    const models = this.parseModels(lines);

    // First pass: collect declared model names so we can classify field types.
    const modelNames = new Set(models.map((m) => m.name));

    const tables: GraphNode[] = [];
    const columns: GraphNode[] = [];
    const indexes: PrismaIndex[] = [];
    const relations: GraphRelationship[] = [];

    for (const m of models) {
      const tableId = this.tableId(repoUrl, m.name);

      // Block-level attrs first — needed to know composite ids/uniques.
      const compositeIdFields = this.parseCompositeFieldList(m.blockAttrs, '@@id');
      const compositeUniqueFields = this.parseCompositeFieldList(m.blockAttrs, '@@unique');

      tables.push({
        id: tableId,
        label: 'Table',
        name: m.name,
        properties: {
          name: m.name,
          repoUrl,
          filePath: relativePath,
          sourceLine: m.startLine,
        },
      });

      // Track which scalar field a relation maps to (so we can mark FK columns).
      const relationScalarFields = new Set<string>();
      for (const f of m.fields) {
        const rel = RELATION_FIELDS_RE.exec(f.attrs);
        if (rel) for (const name of splitCsv(rel[1] ?? '')) relationScalarFields.add(name);
      }

      for (const f of m.fields) {
        // If field type is another declared model, this field IS the relation
        // pointer (no column emitted) — skip it; emit RELATES_TO instead.
        if (modelNames.has(f.type)) {
          const targetId = this.tableId(repoUrl, f.type);
          relations.push({
            type: 'RELATES_TO',
            sourceId: tableId,
            targetId,
            confidence: f.attrs.includes('@relation') ? 'HIGH' : 'MEDIUM',
            properties: {
              fieldName: f.name,
              isList: f.isList,
              nullable: f.nullable,
            },
          });
          continue;
        }

        const isPrimary = /\B@id\b/.test(f.attrs) || compositeIdFields.includes(f.name);
        const isUnique = /\B@unique\b/.test(f.attrs) || compositeUniqueFields.includes(f.name);
        const defaultValue = extractDefaultValue(f.attrs);
        const mapMatch = MAP_ATTR_RE.exec(f.attrs);

        const colId = `${tableId}:${f.name}`;
        const props: Record<string, unknown> = {
          tableId,
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          isPrimary,
          isUnique,
        };
        if (f.isList) props['isList'] = true;
        if (defaultValue !== undefined) props['defaultValue'] = defaultValue;
        if (mapMatch) props['mappedName'] = mapMatch[1];
        if (relationScalarFields.has(f.name)) props['isForeignKey'] = true;

        columns.push({
          id: colId,
          label: 'Column',
          name: f.name,
          properties: props,
        });

        relations.push({
          type: 'HAS',
          sourceId: tableId,
          targetId: colId,
          confidence: 'HIGH',
          properties: {
            sourceLine: f.line,
            ...(SCALAR_TYPES.has(f.type) ? {} : { typeKind: 'unknown' }),
          },
        });
      }

      // @@index / @@unique / @@id → record as Index entries
      for (const attr of m.blockAttrs) {
        const parsed = parseBlockAttr(attr);
        if (!parsed) continue;
        if (parsed.name === '@@index' || parsed.name === '@@unique' || parsed.name === '@@id') {
          const fieldList = FIELDS_LIST_RE.exec(parsed.args);
          const fields = fieldList ? splitCsv(fieldList[1] ?? '') : [];
          if (fields.length === 0) continue;
          indexes.push({
            tableId,
            tableName: m.name,
            fields,
            kind: parsed.name === '@@index' ? 'index'
              : parsed.name === '@@unique' ? 'unique'
              : 'id',
          });
        }
      }
    }

    return { tables, columns, indexes, relations };
  }

  private parseModels(lines: readonly string[]): readonly ParsedModel[] {
    const out: ParsedModel[] = [];
    let current: MutableModel | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!current) {
        const header = MODEL_HEADER_RE.exec(line);
        if (header) {
          current = {
            name: header[1]!,
            startLine: i + 1,
            fields: [],
            blockAttrs: [],
          };
        }
        continue;
      }
      if (/^\s*\}\s*$/.test(line)) {
        out.push({
          name: current.name,
          startLine: current.startLine,
          fields: current.fields,
          blockAttrs: current.blockAttrs,
        });
        current = undefined;
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('@@')) {
        current.blockAttrs.push(trimmed);
        continue;
      }
      const fm = FIELD_RE.exec(line);
      if (!fm) continue;
      // Strip trailing comment
      const attrs = (fm[5] ?? '').replace(/\/\/.*$/, '').trim();
      current.fields.push({
        name: fm[1]!,
        type: fm[2]!,
        isList: Boolean(fm[3]),
        nullable: Boolean(fm[4]),
        attrs,
        line: i + 1,
      });
    }
    return out;
  }

  private parseCompositeFieldList(blockAttrs: readonly string[], name: string): readonly string[] {
    for (const a of blockAttrs) {
      const parsed = parseBlockAttr(a);
      if (!parsed || parsed.name !== name) continue;
      const m = FIELDS_LIST_RE.exec(parsed.args);
      if (m) return splitCsv(m[1] ?? '');
    }
    return [];
  }

  private tableId(repoUrl: string, modelName: string): string {
    return `table:${repoUrl}:${modelName}`;
  }
}

interface ParsedModel {
  readonly name: string;
  readonly startLine: number;
  readonly fields: readonly ParsedField[];
  readonly blockAttrs: readonly string[];
}

interface MutableModel {
  name: string;
  startLine: number;
  fields: ParsedField[];
  blockAttrs: string[];
}

function parseBlockAttr(line: string): { name: string; args: string } | undefined {
  const m = BLOCK_ATTR_RE.exec(line);
  if (!m) return undefined;
  return { name: m[1]!, args: m[2] ?? '' };
}

/** Extract the balanced argument string from `@default(...)`, handling nested parens. */
function extractDefaultValue(attrs: string): string | undefined {
  const m = DEFAULT_ATTR_START_RE.exec(attrs);
  if (!m) return undefined;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < attrs.length && depth > 0) {
    const ch = attrs[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return undefined;
  return attrs.slice(start, i).trim();
}

function splitCsv(s: string): readonly string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}
