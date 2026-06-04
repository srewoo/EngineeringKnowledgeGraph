/**
 * Data lineage pass (Phase G).
 *
 * Derives `(API)-[:EXPOSES_DATA]->(Column)` edges from already-extracted
 * nodes. Lets agents answer "if I rename the `user.email` column, which
 * APIs break?" — currently un-answerable because the static graph has
 * APIs and Tables but no link between them.
 *
 * Scope (intentionally conservative to keep noise low):
 *   - Only consider Columns of Tables OWNed by the same Service that
 *     EXPOSES the API. Cross-service field-name matches are out of scope.
 *   - Skip generic field names (id, name, created_at, ...) — they would
 *     pollute the graph by matching everywhere.
 *   - Normalise camelCase ↔ snake_case before matching.
 *   - Two confidences:
 *       HIGH   — exact name match after normalisation
 *       MEDIUM — suffix/prefix containment (e.g. `userEmail` ↔ `email`)
 *
 * Pure derivation. No I/O. Idempotent. Safe to run multiple times.
 */

import { createLogger } from '@ekg/shared';
import type { GraphNode, GraphRelationship, Logger } from '@ekg/shared';

export interface DataLineagePassInput {
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
}

export interface DataLineagePassResult {
  readonly newRelationships: readonly GraphRelationship[];
  readonly stats: Readonly<{
    apisProcessed: number;
    columnsConsidered: number;
    edgesEmitted: number;
    apisWithoutSchema: number;
    apisWithoutService: number;
  }>;
}

/** Column names too generic to match meaningfully — would create noise. */
const GENERIC_COLUMN_NAMES = new Set([
  'id', 'name', 'type', 'kind', 'status', 'state', 'value', 'data',
  'created_at', 'updated_at', 'deleted_at', 'createdat', 'updatedat',
  'created', 'updated', 'modified', 'version', 'tenant_id', 'tenantid',
  'user_id', 'userid', 'org_id', 'orgid',
]);

/** Generic field names in schemas — same rationale. */
const GENERIC_FIELD_NAMES = GENERIC_COLUMN_NAMES;

export class DataLineagePass {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'data-lineage-pass' });
  }

  run(input: DataLineagePassInput): DataLineagePassResult {
    // -- Index pass: collect what we need by id --
    const apiById = new Map<string, GraphNode>();
    const columnById = new Map<string, GraphNode>();
    const tableById = new Map<string, GraphNode>();
    for (const n of input.nodes) {
      if (n.label === 'API') apiById.set(n.id, n);
      else if (n.label === 'Column') columnById.set(n.id, n);
      else if (n.label === 'Table') tableById.set(n.id, n);
    }
    if (apiById.size === 0 || columnById.size === 0) {
      return {
        newRelationships: [],
        stats: {
          apisProcessed: apiById.size,
          columnsConsidered: columnById.size,
          edgesEmitted: 0,
          apisWithoutSchema: 0,
          apisWithoutService: 0,
        },
      };
    }

    // service ← API via EXPOSES
    const serviceByApi = new Map<string, string>();
    // service → tables via OWNS
    const tablesByService = new Map<string, string[]>();
    // table → columns via HAS
    const columnsByTable = new Map<string, string[]>();
    for (const rel of input.relationships) {
      if (rel.type === 'EXPOSES' && apiById.has(rel.targetId)) {
        serviceByApi.set(rel.targetId, rel.sourceId);
      } else if (rel.type === 'OWNS' && tableById.has(rel.targetId)) {
        const list = tablesByService.get(rel.sourceId) ?? [];
        list.push(rel.targetId);
        tablesByService.set(rel.sourceId, list);
      } else if (rel.type === 'HAS' && columnById.has(rel.targetId)) {
        const list = columnsByTable.get(rel.sourceId) ?? [];
        list.push(rel.targetId);
        columnsByTable.set(rel.sourceId, list);
      }
    }

    // -- Per-API derivation --
    const newRels: GraphRelationship[] = [];
    const seen = new Set<string>();
    let apisWithoutSchema = 0;
    let apisWithoutService = 0;

    for (const [apiId, apiNode] of apiById) {
      const schemaFields = extractFieldNames(apiNode);
      if (schemaFields.size === 0) { apisWithoutSchema += 1; continue; }
      const svcId = serviceByApi.get(apiId);
      if (!svcId) { apisWithoutService += 1; continue; }

      const tables = tablesByService.get(svcId) ?? [];
      for (const tableId of tables) {
        const columnIds = columnsByTable.get(tableId) ?? [];
        for (const colId of columnIds) {
          const colNode = columnById.get(colId);
          if (!colNode) continue;
          const colName = ((colNode.properties as { name?: string }).name ?? '').toLowerCase();
          if (!colName || GENERIC_COLUMN_NAMES.has(colName)) continue;

          const match = matchField(schemaFields, colName);
          if (!match) continue;
          const key = `${apiId}#${colId}`;
          if (seen.has(key)) continue;
          seen.add(key);

          newRels.push({
            type: 'EXPOSES_DATA',
            sourceId: apiId,
            targetId: colId,
            confidence: match.confidence,
            properties: { matchedField: match.field, matchKind: match.kind },
          });
        }
      }
    }

    this.logger.info({
      apisProcessed: apiById.size,
      columnsConsidered: columnById.size,
      edgesEmitted: newRels.length,
      apisWithoutSchema,
      apisWithoutService,
    }, 'data lineage pass complete');

    return {
      newRelationships: newRels,
      stats: {
        apisProcessed: apiById.size,
        columnsConsidered: columnById.size,
        edgesEmitted: newRels.length,
        apisWithoutSchema,
        apisWithoutService,
      },
    };
  }
}

// ----- helpers -----

/**
 * Walk an API node's request + response schemas (which are stored as JSON
 * strings on the graph) and collect all leaf field names, normalised.
 */
function extractFieldNames(api: GraphNode): Set<string> {
  const props = api.properties as { requestSchema?: unknown; responseSchemas?: unknown };
  const fields = new Set<string>();
  const req = parseSchema(props.requestSchema);
  collectFieldsRecursive(req, fields, 0);
  const resp = parseSchema(props.responseSchemas);
  if (resp && typeof resp === 'object') {
    for (const value of Object.values(resp as Record<string, unknown>)) {
      collectFieldsRecursive(value, fields, 0);
    }
  }
  return fields;
}

function parseSchema(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length === 0) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function collectFieldsRecursive(schema: unknown, out: Set<string>, depth: number): void {
  if (!schema || typeof schema !== 'object' || depth > 5) return;
  const obj = schema as Record<string, unknown>;
  const properties = obj['properties'];
  if (properties && typeof properties === 'object') {
    for (const [k, v] of Object.entries(properties as Record<string, unknown>)) {
      const norm = normalize(k);
      if (norm && !GENERIC_FIELD_NAMES.has(norm)) out.add(norm);
      collectFieldsRecursive(v, out, depth + 1);
    }
  }
  // Handle array `items` schemas.
  const items = obj['items'];
  if (items) collectFieldsRecursive(items, out, depth + 1);
}

/**
 * Normalise to lowercase snake_case so `userEmail` and `user_email` collide.
 * Pure — exported only conceptually.
 */
function normalize(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

interface FieldMatch {
  readonly field: string;
  readonly kind: 'exact' | 'suffix' | 'prefix' | 'contains';
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Find the best field match for a column name. Caller has already normalised
 * the column name. We try in order: exact → suffix → prefix → contains.
 */
function matchField(fields: ReadonlySet<string>, colName: string): FieldMatch | undefined {
  if (fields.has(colName)) {
    return { field: colName, kind: 'exact', confidence: 'HIGH' };
  }
  // Suffix: e.g. `customerEmail` field matches `email` column
  for (const f of fields) {
    if (f.length > colName.length && f.endsWith(`_${colName}`)) {
      return { field: f, kind: 'suffix', confidence: 'MEDIUM' };
    }
  }
  // Prefix: less common but covers `<col>_id` style API fields mapping back
  for (const f of fields) {
    if (f.length > colName.length && f.startsWith(`${colName}_`)) {
      return { field: f, kind: 'prefix', confidence: 'MEDIUM' };
    }
  }
  return undefined;
}

/** Exported for tests. */
export const __internals = { normalize, extractFieldNames, matchField };
