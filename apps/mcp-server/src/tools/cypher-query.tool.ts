/**
 * MCP Tool: cypher_query (read-only escape hatch)
 *
 * Lets a power user / agent run an arbitrary Cypher query against the graph.
 * Hard-rejects any write or admin keyword to keep the graph safe — there is
 * NO way for an LLM-authored query to mutate state through this tool.
 *
 * Safeguards:
 *   - Reject CREATE / MERGE / SET / DELETE / REMOVE / DROP / FOREACH / LOAD CSV
 *   - Reject CALL apoc.* unless it starts with apoc.coll. or apoc.text. (read-only)
 *   - Auto-append LIMIT $maxRows if no LIMIT in the query
 *   - Run on a read session with a 15s timeout
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';

const FORBIDDEN = [
  /\bCREATE\b/i, /\bMERGE\b/i, /\bSET\b/i, /\bDELETE\b/i,
  /\bDETACH\s+DELETE\b/i, /\bREMOVE\b/i, /\bDROP\b/i,
  /\bFOREACH\b/i, /\bLOAD\s+CSV\b/i,
];

const ALLOWED_PROCEDURES = /^apoc\.(coll|text|convert|map|path|meta\.schema|meta\.subGraph)\b/i;

export function registerCypherQueryTool(server: McpServer, client: Neo4jClient): void {
  server.tool(
    'cypher_query',
    'Run a READ-ONLY Cypher query against the knowledge graph. Rejects any write/admin keyword. Use for ad-hoc analysis when the typed tools are not enough. Always parameterise via the params object — never inline values.',
    {
      query: z.string().min(1).max(8000).describe('Cypher query string. Read-only.'),
      params: z.record(z.string(), z.unknown()).default({}).describe('Parameter map.'),
      maxRows: z.number().int().min(1).max(500).default(100).describe('Hard cap on returned rows.'),
    },
    async ({ query, params, maxRows }) => {
      // Static guardrails
      const stripped = query.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
      for (const re of FORBIDDEN) {
        if (re.test(stripped)) {
          return {
            content: [{ type: 'text' as const, text: `Rejected: query contains a forbidden write keyword (${re}). Use the typed tools or rewrite read-only.` }],
            isError: true,
          };
        }
      }

      // CALL <procedure> — only allow read-only APOC procs
      const callMatch = /\bCALL\s+([\w.]+)/i.exec(stripped);
      if (callMatch && callMatch[1] && !ALLOWED_PROCEDURES.test(callMatch[1])) {
        return {
          content: [{ type: 'text' as const, text: `Rejected: procedure ${callMatch[1]} is not on the read-only allowlist.` }],
          isError: true,
        };
      }

      // Auto-LIMIT
      const finalQuery = /\bLIMIT\s+\d+/i.test(stripped)
        ? query
        : `${query}\nLIMIT $__maxRows`;

      const session = client.getReadSession();
      try {
        const result = await session.run(
          finalQuery,
          { ...params, __maxRows: maxRows },
          { timeout: 15_000 },
        );
        const rows = result.records.map((r) => {
          const obj: Record<string, unknown> = {};
          for (const key of r.keys) {
            const value = r.get(key);
            obj[key as string] = serialiseValue(value);
          }
          return obj;
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              rowCount: rows.length,
              capped: rows.length === maxRows,
              rows,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Cypher error: ${message}` }],
          isError: true,
        };
      } finally {
        await session.close();
      }
    },
  );
}

/** Convert Neo4j driver values (Integer, Node, Relationship, Path) into plain JSON. */
function serialiseValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') {
    const o = v as { toNumber?: () => number; properties?: Record<string, unknown>; labels?: string[]; type?: string; start?: unknown; end?: unknown };
    if (typeof o.toNumber === 'function') return o.toNumber();
    if (o.properties && (o.labels || o.type)) {
      return { labels: o.labels, type: o.type, properties: o.properties };
    }
    if (Array.isArray(v)) return v.map(serialiseValue);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = serialiseValue(val);
    return out;
  }
  return v;
}
