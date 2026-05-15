/**
 * MCP Tool: answer_question (Phase 3 — agentic Q&A)
 *
 * Runs the @ekg/agent tool-loop end-to-end. Opt-in via EKG_AGENT_ENABLED=true.
 * Distinct from `ask_question` (Phase 2.3 retrieval-only) — this one returns
 * a prose answer with strict citation validation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';
import { HybridSearch, Neo4jGraphExpander, getReranker } from '@ekg/search';
import type { SearchTextRepository, AgentSessionRepository } from '@ekg/storage';
import type { EmbeddingsService } from '@ekg/worker';
import type { Neo4jClient } from '@ekg/graph';
import {
  Agent,
  ToolRegistry,
  buildGraphCypherTool,
  buildFindTableTool,
  buildFindFunctionTool,
  buildSemanticRetrieveTool,
  buildCodeReadTool,
  buildGitBlameTool,
  buildRouteClassifyTool,
  getAgentProvider,
  readAgentEnv,
  makeStreamingAgent,
} from '@ekg/agent';

export interface AnswerQuestionDeps {
  readonly searchText: SearchTextRepository;
  readonly embeddingsService?: EmbeddingsService;
  readonly neo4jClient: Neo4jClient;
  readonly reposRoot?: string;
  readonly sessions?: AgentSessionRepository;
}

export function registerAnswerQuestionTool(server: McpServer, deps: AnswerQuestionDeps): void {
  const logger = createLogger({ service: 'answer-question-tool' });
  const env = readAgentEnv();

  server.tool(
    'answer_question',
    'Phase 3 agentic Q&A: an LLM uses EKG retrieval as tools and returns an answer with strict citations. Opt-in: requires EKG_AGENT_ENABLED=true plus EKG_AGENT_PROVIDER + provider credentials.',
    {
      question: z.string().min(1).describe('Natural-language question'),
      repo: z.string().optional().describe('Restrict to a single repo URL'),
      sessionId: z.string().uuid().optional().describe('Multi-turn session id from start_session'),
      stream: z.boolean().optional().describe('Opt-in streaming events; falls back to env EKG_AGENT_STREAMING'),
    },
    async ({ question, repo, sessionId, stream }) => {
      if (!env.enabled) {
        return {
          content: [{
            type: 'text' as const,
            text: 'answer_question is disabled. Set EKG_AGENT_ENABLED=true plus EKG_AGENT_PROVIDER (openai|anthropic|ollama) and the matching API key (OPENAI_API_KEY / ANTHROPIC_API_KEY) or OLLAMA_URL. Optionally set EKG_AGENT_MODEL.',
          }],
          isError: true,
        };
      }
      try {
        const provider = getAgentProvider();
        const embEnabled = !!deps.embeddingsService?.enabled;
        const expander = new Neo4jGraphExpander(deps.neo4jClient);
        let reranker;
        try { reranker = getReranker(); } catch { reranker = undefined; }

        const hybrid = new HybridSearch({
          searchText: deps.searchText,
          ...(embEnabled && deps.embeddingsService
            ? {
                embeddingsRepo: deps.embeddingsService.getRepository(),
                embeddingProvider: deps.embeddingsService.getProvider(),
              }
            : {}),
          ...(reranker ? { reranker } : {}),
          graphExpander: expander,
        });

        const registry = new ToolRegistry([
          buildGraphCypherTool(deps.neo4jClient),
          buildFindTableTool(deps.neo4jClient),
          buildFindFunctionTool(deps.neo4jClient),
          buildSemanticRetrieveTool(hybrid),
          buildCodeReadTool(deps.reposRoot ? { reposRoot: deps.reposRoot } : {}),
          buildGitBlameTool(deps.reposRoot ? { reposRoot: deps.reposRoot } : {}),
          buildRouteClassifyTool(),
        ]);

        const agent = new Agent({
          provider,
          tools: registry,
          planExecutor: { hybrid, neo4j: deps.neo4jClient },
          ...(deps.sessions ? { sessions: deps.sessions } : {}),
        });

        const wantsStream = stream ?? env.streaming;
        const askOpts = {
          ...(repo ? { repo } : {}),
          ...(sessionId ? { sessionId } : {}),
          maxTokens: env.maxTokens,
        };
        let envelope;
        if (wantsStream) {
          // MCP SDK doesn't currently expose a clean streaming-response API
          // from tool handlers; we collect deltas and return the full envelope.
          // The streaming-internal API is still useful for direct callers.
          const streaming = makeStreamingAgent(agent);
          for await (const evt of streaming.askStream(question, askOpts)) {
            if (evt.kind === 'final') envelope = evt.envelope;
          }
          if (!envelope) throw new Error('streaming agent produced no final envelope');
          logger.info({ stream: true }, 'answer_question stream collected');
        } else {
          envelope = await agent.ask(question, askOpts);
        }
        logger.info(
          { status: envelope.status, iterations: envelope.usage.iterations, tokens: envelope.usage, sessionId },
          'answer_question completed',
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
          ...(envelope.status === 'error' ? { isError: true } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'answer_question failed');
        return {
          content: [{ type: 'text' as const, text: `answer_question failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
