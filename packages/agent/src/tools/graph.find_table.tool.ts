/**
 * graph.find_table — direct lookup of a Table node + its columns.
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

export function buildFindTableTool(neo4j: Neo4jClient): AgentTool<Input> {
  return {
    name: 'graph.find_table',
    description: 'Find Table nodes by name (case-insensitive contains) and return their columns.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Table name or substring.' },
        repoUrl: { type: 'string', description: 'Optional repo filter.' },
      },
      required: ['name'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const cypher = `
        MATCH (t:Table)
        WHERE toLower(coalesce(t.name, '')) CONTAINS toLower($needle)
          ${input.repoUrl ? 'AND t.repoUrl = $repoUrl' : ''}
        OPTIONAL MATCH (t)-[:HAS]->(c:Column)
        WITH t, collect(DISTINCT { name: c.name, type: c.type, nullable: c.nullable }) AS columns
        RETURN t.id AS id, t.name AS name, t.repoUrl AS repoUrl, columns
        LIMIT ${MAX_ROWS}
      `.trim();
      const params: Record<string, unknown> = { needle: input.name };
      if (input.repoUrl) params['repoUrl'] = input.repoUrl;

      const rows = await neo4j.executeRead(async (tx) => {
        const r = await tx.run(cypher, params);
        return r.records.map((rec) => rec.toObject() as Record<string, unknown>);
      });
      const seenIds = rows
        .map((r) => r['id'])
        .filter((v): v is string => typeof v === 'string')
        .map((id) => `Table:${id}`);
      return {
        text: JSON.stringify({ matches: rows, count: rows.length }, null, 2),
        seenIds,
        raw: { rows },
      };
    },
  };
}
