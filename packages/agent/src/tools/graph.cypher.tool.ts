/**
 * graph.cypher — execute a parameterised, read-only Cypher query.
 *
 * Hard rules:
 *  - Reject any clause that mutates the graph (CREATE, MERGE, DELETE, SET,
 *    REMOVE, DROP, CALL apoc.* with side effects, LOAD CSV, etc.).
 *  - LIMIT is enforced (defaults applied if missing).
 *  - Always parameterised — the agent supplies `params`, never inlines values.
 */

import { z } from 'zod';
import type { Neo4jClient } from '@ekg/graph';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

const MAX_ROWS = 50;
const RESULT_TEXT_CAP = 8000;

const inputSchema = z.object({
  cypher: z.string().min(1).max(4000),
  params: z.record(z.unknown()).optional(),
});
type Input = z.infer<typeof inputSchema>;

const FORBIDDEN = [
  /\bCREATE\b/i,
  /\bMERGE\b/i,
  /\bDELETE\b/i,
  /\bDETACH\b/i,
  /\bSET\b/i,
  /\bREMOVE\b/i,
  /\bDROP\b/i,
  /\bLOAD\s+CSV\b/i,
  /\bCALL\b\s+\{[^}]*\b(CREATE|MERGE|DELETE|SET|REMOVE)\b/i,
  /\bUSING\s+PERIODIC\s+COMMIT\b/i,
  /\bFOREACH\b/i,
];

export function isReadOnlyCypher(query: string): { ok: true } | { ok: false; reason: string } {
  for (const pat of FORBIDDEN) {
    if (pat.test(query)) {
      return { ok: false, reason: `mutation keyword detected: ${pat.source}` };
    }
  }
  return { ok: true };
}

export function buildGraphCypherTool(neo4j: Neo4jClient): AgentTool<Input> {
  return {
    name: 'graph.cypher',
    description:
      'Execute a parameterised READ-ONLY Cypher query against the EKG graph. ' +
      'Use $-prefixed parameters and provide them in `params`. Mutation clauses are rejected.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        cypher: { type: 'string', description: 'Read-only Cypher query.' },
        params: { type: 'object', description: 'Parameters for the query.', additionalProperties: true },
      },
      required: ['cypher'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const guard = isReadOnlyCypher(input.cypher);
      if (!guard.ok) {
        throw new Error(`graph.cypher refused: ${guard.reason}`);
      }
      const cypher = ensureLimit(input.cypher);
      const params = input.params ?? {};
      const rows = await neo4j.executeRead(async (tx) => {
        const r = await tx.run(cypher, params);
        return r.records.slice(0, MAX_ROWS).map((rec) => rec.toObject() as Record<string, unknown>);
      });
      const seenIds = collectIds(rows);
      const text = truncate(JSON.stringify({ rows, count: rows.length }, null, 2), RESULT_TEXT_CAP);
      return { text, seenIds, raw: { rows } };
    },
  };
}

function ensureLimit(query: string): string {
  if (/\bLIMIT\s+\d+/i.test(query)) return query;
  return `${query.trimEnd()}\nLIMIT ${MAX_ROWS}`;
}

function collectIds(rows: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && (k === 'id' || k.endsWith('Id') || k.endsWith('_id'))) {
        out.push(v);
      }
    }
  }
  return out;
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n[truncated ${s.length - cap} chars]`;
}
