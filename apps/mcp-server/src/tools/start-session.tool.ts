/**
 * MCP Tool: start_session — creates a new agent multi-turn session and
 * returns its id. Caller threads the id through subsequent answer_question
 * calls.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '@ekg/shared';
import type { AgentSessionRepository } from '@ekg/storage';

export function registerStartSessionTool(
  server: McpServer,
  sessions: AgentSessionRepository,
): void {
  const logger = createLogger({ service: 'start-session-tool' });
  server.tool(
    'start_session',
    'Create a new agent multi-turn session. Returns { sessionId } to thread through answer_question.',
    {},
    async () => {
      const { sessionId } = sessions.create();
      logger.info({ sessionId }, 'agent session started');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessionId }) }],
      };
    },
  );
}
