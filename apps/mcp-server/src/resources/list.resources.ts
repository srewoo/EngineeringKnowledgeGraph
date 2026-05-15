/**
 * MCP Resources: ekg://services, ekg://databases
 *
 * Static resources exposing lists of services and databases.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

export function registerServiceListResource(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.resource(
    'services',
    'ekg://services',
    {
      description: 'List of all services in the engineering knowledge graph',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const services = await queries.listServices();
        return {
          contents: [{
            uri: 'ekg://services',
            mimeType: 'application/json',
            text: JSON.stringify({
              count: services.length,
              services: services.map((s) => ({ name: s.name, ...s.properties })),
            }, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ekg://services',
            mimeType: 'application/json',
            text: JSON.stringify({ count: 0, services: [], error: 'Graph unavailable' }, null, 2),
          }],
        };
      }
    },
  );
}

export function registerDatabaseListResource(
  server: McpServer,
  queries: GraphQueries,
): void {
  server.resource(
    'databases',
    'ekg://databases',
    {
      description: 'List of all databases in the engineering knowledge graph',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const databases = await queries.listDatabases();
        return {
          contents: [{
            uri: 'ekg://databases',
            mimeType: 'application/json',
            text: JSON.stringify({
              count: databases.length,
              databases: databases.map((d) => ({ name: d.name, ...d.properties })),
            }, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ekg://databases',
            mimeType: 'application/json',
            text: JSON.stringify({ count: 0, databases: [], error: 'Graph unavailable' }, null, 2),
          }],
        };
      }
    },
  );
}
