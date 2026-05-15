/**
 * MCP Tool: ask_question (Phase 2.3 — query planner / router)
 *
 * Smart question router. Classifies the question, picks a retrieval strategy
 * (graph / hybrid / multi-hop), executes the plan, and returns ranked results
 * along with the routing trace.
 *
 * Does NOT generate prose answers — that's the agent layer (Phase 3).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '@ekg/shared';
import { HybridSearch, Neo4jGraphExpander, getReranker } from '@ekg/search';
import {
  classify,
  selectStrategy,
  executePlan,
  getLlmRouter,
  ROUTER_LLM_THRESHOLD,
  type ClassificationResult,
  type QuestionClass,
} from '@ekg/router';
import type { SearchTextRepository } from '@ekg/storage';
import type { EmbeddingsService } from '@ekg/worker';
import type { Neo4jClient } from '@ekg/graph';

const MAX_K = 50;

export interface AskQuestionDeps {
  readonly searchText: SearchTextRepository;
  readonly embeddingsService?: EmbeddingsService;
  readonly neo4jClient: Neo4jClient;
}

export function registerAskQuestionTool(server: McpServer, deps: AskQuestionDeps): void {
  const logger = createLogger({ service: 'ask-question-tool' });

  server.tool(
    'ask_question',
    'Smart question router. Classifies the question, picks retrieval strategy (graph/hybrid/multi-hop), executes, and returns ranked results with the routing trace. Does NOT generate prose answers — that is the agent layer\'s job (Phase 3).',
    {
      question: z.string().min(1).describe('Natural-language question'),
      repo: z.string().optional().describe('Restrict to a single repo URL'),
      k: z.number().int().min(1).max(MAX_K).default(10).describe(`Number of results (1-${MAX_K})`),
    },
    async ({ question, repo, k }) => {
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'ask_question requires a non-empty question.' }],
          isError: true,
        };
      }
      const cappedK = Math.min(Math.max(k, 1), MAX_K);

      try {
        const ruleResult = classify(trimmed);
        const finalClass = await maybeFallback(trimmed, ruleResult, logger);
        const strategy = selectStrategy(finalClass.class);

        const embEnabled = !!deps.embeddingsService?.enabled;
        const expander = new Neo4jGraphExpander(deps.neo4jClient);
        let reranker;
        try {
          reranker = getReranker();
        } catch {
          reranker = undefined;
        }

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

        const plan = await executePlan(
          trimmed,
          finalClass.class,
          strategy,
          { hybrid, neo4j: deps.neo4jClient },
          { k: cappedK, ...(repo ? { repoUrl: repo } : {}) },
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              question: trimmed,
              classification: {
                rule: { class: ruleResult.class, confidence: ruleResult.confidence, signals: ruleResult.signals },
                final: { class: finalClass.class, confidence: finalClass.confidence, source: finalClass.source },
              },
              strategy: plan.strategy,
              entities: plan.entities,
              sources: plan.sources,
              notes: plan.notes,
              duration_ms: plan.duration_ms,
              results: plan.results,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `ask_question failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

interface FinalClassification {
  readonly class: QuestionClass;
  readonly confidence: number;
  readonly source: 'rule' | 'llm';
}

async function maybeFallback(
  question: string,
  rule: ClassificationResult,
  logger: ReturnType<typeof createLogger>,
): Promise<FinalClassification> {
  if (rule.confidence >= ROUTER_LLM_THRESHOLD) {
    return { class: rule.class, confidence: rule.confidence, source: 'rule' };
  }
  let llm;
  try {
    llm = getLlmRouter();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LLM router init failed');
    return { class: rule.class, confidence: rule.confidence, source: 'rule' };
  }
  if (!llm) {
    return { class: rule.class, confidence: rule.confidence, source: 'rule' };
  }
  try {
    const result = await llm.classify(question);
    logger.info({ class: result.class, confidence: result.confidence, provider: llm.id }, 'LLM router fallback used');
    return { class: result.class, confidence: result.confidence, source: 'llm' };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LLM router fallback failed; using rule result');
    return { class: rule.class, confidence: rule.confidence, source: 'rule' };
  }
}
