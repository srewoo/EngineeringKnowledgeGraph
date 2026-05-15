/**
 * Shared test helpers for agent unit tests. Provides a scripted provider, a
 * fake hybrid+neo4j shim, and a builder for AgentDeps.
 */

import { z } from 'zod';
import { Agent } from '../../src/agent.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentTool } from '../../src/tools/tool.interface.js';
import type {
  LlmProvider,
  CompletionRequest,
  CompletionResponse,
} from '../../src/provider.interface.js';
import type { SessionRepoLike } from '../../src/session.js';

export class ScriptedProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model = 'gpt-4o-mini';
  private idx = 0;
  constructor(private readonly script: ReadonlyArray<Partial<CompletionResponse>>) {}
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    const next = this.script[this.idx];
    this.idx += 1;
    if (!next) throw new Error('ScriptedProvider: out of script');
    return {
      content: next.content ?? '',
      toolCalls: next.toolCalls ?? [],
      usage: next.usage ?? { inputTokens: 10, outputTokens: 10 },
      stopReason: next.stopReason ?? (next.toolCalls && next.toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    };
  }
}

export function makeSampleTool(name = 'sample.tool', seenId = 'Sample:42'): AgentTool<{ q: string }> {
  return {
    name,
    description: 'returns a fixed seen id',
    schema: z.object({ q: z.string() }),
    jsonSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async invoke(input) {
      return { text: `result for ${input.q}`, seenIds: [seenId] };
    },
  };
}

export function makeFakeNeo4j(rows: Record<string, unknown>[] = []): unknown {
  return {
    async executeRead<T>(work: (tx: { run: (q: string, p: unknown) => Promise<{ records: { toObject: () => Record<string, unknown> }[] }> }) => Promise<T>): Promise<T> {
      const records = rows.map((r) => ({ toObject: () => r }));
      return work({ run: async () => ({ records }) });
    },
  };
}

export function makeFakeHybrid(): unknown {
  return { async search(): Promise<unknown[]> { return []; } };
}

export interface InMemorySession {
  sessionId: string;
  messages: string;
  seenIds: string;
  metadata: string | undefined;
}

export class InMemorySessionRepo implements SessionRepoLike {
  private readonly data = new Map<string, InMemorySession>();
  create(sessionId: string): void {
    this.data.set(sessionId, { sessionId, messages: '[]', seenIds: '[]', metadata: undefined });
  }
  get(sessionId: string): { messages: string; seenIds: string; metadata: string | undefined } | undefined {
    const r = this.data.get(sessionId);
    return r ? { messages: r.messages, seenIds: r.seenIds, metadata: r.metadata } : undefined;
  }
  update(sessionId: string, fields: { messages?: string; seenIds?: string; metadata?: string }): void {
    const r = this.data.get(sessionId);
    if (!r) return;
    if (fields.messages !== undefined) r.messages = fields.messages;
    if (fields.seenIds !== undefined) r.seenIds = fields.seenIds;
    if (fields.metadata !== undefined) r.metadata = fields.metadata;
  }
}

export function buildAgent(provider: LlmProvider, tools: AgentTool[], sessions?: SessionRepoLike): Agent {
  const registry = new ToolRegistry(tools);
  return new Agent({
    provider,
    tools: registry,
    planExecutor: {
      hybrid: makeFakeHybrid() as unknown as import('@ekg/search').HybridSearch,
      neo4j: makeFakeNeo4j() as unknown as import('@ekg/graph').Neo4jClient,
    },
    ...(sessions ? { sessions } : {}),
  });
}
