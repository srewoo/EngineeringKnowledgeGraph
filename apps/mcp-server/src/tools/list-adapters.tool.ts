/**
 * MCP Tool: list_adapters
 *
 * Surfaces every registered McpAdapter, its capabilities, and its current
 * health snapshot from the registry.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdapterRegistry } from '@ekg/adapters';

export function registerListAdaptersTool(server: McpServer, registry: AdapterRegistry): void {
  server.tool(
    'list_adapters',
    'List configured external MCP adapters (Datadog, etc.), their capabilities and health.',
    {},
    async () => {
      const all = registry.listAll();
      const adapters = all.map(({ adapter, healthy, priority }) => ({
        id: adapter.id,
        capabilities: adapter.capabilities,
        priority,
        healthy,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ adapters, count: adapters.length }, null, 2),
        }],
      };
    },
  );
}
