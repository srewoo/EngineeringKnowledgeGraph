/**
 * graph.find_function — direct lookup of Function/Method nodes by name.
 */

import { z } from 'zod';
import type { Neo4jClient } from '@ekg/graph';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

const MAX_ROWS = 25;

const inputSchema = z.object({
  name: z.string().min(1).max(200),
  repoUrl: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

export function buildFindFunctionTool(neo4j: Neo4jClient): AgentTool<Input> {
  return {
    name: 'graph.find_function',
    description: 'Find Function or Method nodes by name (case-insensitive contains) with metadata and defining file.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function or method name (or substring).' },
        repoUrl: { type: 'string', description: 'Optional repo filter.' },
      },
      required: ['name'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const cypher = `
        MATCH (n)
        WHERE (n:Function OR n:Method)
          AND toLower(coalesce(n.name, '')) CONTAINS toLower($needle)
          ${input.repoUrl ? 'AND n.repoUrl = $repoUrl' : ''}
        OPTIONAL MATCH (f:File)-[:DEFINES]->(n)
        RETURN
          n.id AS id,
          labels(n)[0] AS label,
          n.name AS name,
          coalesce(n.signature, '') AS signature,
          coalesce(n.lang, '') AS lang,
          coalesce(n.lineStart, 0) AS lineStart,
          coalesce(n.lineEnd, 0) AS lineEnd,
          coalesce(f.path, '') AS path,
          coalesce(f.repoUrl, n.repoUrl, '') AS repoUrl
        LIMIT ${MAX_ROWS}
      `.trim();
      const params: Record<string, unknown> = { needle: input.name };
      if (input.repoUrl) params['repoUrl'] = input.repoUrl;

      const rows = await neo4j.executeRead(async (tx) => {
        const r = await tx.run(cypher, params);
        return r.records.map((rec) => rec.toObject() as Record<string, unknown>);
      });
      const seenIds = rows
        .filter((r) => typeof r['id'] === 'string' && typeof r['label'] === 'string')
        .map((r) => `${r['label'] as string}:${r['id'] as string}`);
      return {
        text: JSON.stringify({ matches: rows, count: rows.length }, null, 2),
        seenIds,
        raw: { rows },
      };
    },
  };
}
