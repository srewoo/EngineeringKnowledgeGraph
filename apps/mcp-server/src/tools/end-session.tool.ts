/**
 * MCP Tool: end_session — terminates an agent multi-turn session by deleting
 * its row. Idempotent: returns ok=false if the session was not found.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import type { AgentSessionRepository } from '@ekg/storage';

export function registerEndSessionTool(
  server: McpServer,
  sessions: AgentSessionRepository,
): void {
  const logger = createLogger({ service: 'end-session-tool' });
  server.tool(
    'end_session',
    'Terminate an agent multi-turn session.',
    { sessionId: z.string().uuid() },
    async ({ sessionId }) => {
      const ok = sessions.delete(sessionId);
      logger.info({ sessionId, ok }, 'agent session ended');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessionId, ok }) }],
      };
    },
  );
}
