import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../src/agent.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { AgentTool } from '../../src/tools/tool.interface.js';
import type {
  LlmProvider,
  CompletionRequest,
  CompletionResponse,
} from '../../src/provider.interface.js';

function makeFakeNeo4j(rows: Record<string, unknown>[] = []): { executeRead: <T>(work: (tx: { run: (q: string, p: unknown) => Promise<{ records: { toObject: () => Record<string, unknown> }[] }> }) => Promise<T>) => Promise<T> } {
  return {
    async executeRead<T>(work: (tx: { run: (q: string, p: unknown) => Promise<{ records: { toObject: () => Record<string, unknown> }[] }> }) => Promise<T>): Promise<T> {
      const records = rows.map((r) => ({ toObject: () => r }));
      return work({ run: async () => ({ records }) });
    },
  };
}

function makeFakeHybrid(): {
  search: (q: string, opts?: unknown) => Promise<unknown[]>;
} {
  return { async search() { return []; } };
}

const sampleTool: AgentTool<{ q: string }> = {
  name: 'sample.tool',
  description: 'returns a fixed seen id',
  schema: z.object({ q: z.string() }),
  jsonSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  async invoke(input) {
    return { text: `result for ${input.q}`, seenIds: ['Sample:42'] };
  },
};

class ScriptedProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model = 'fake';
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

function makeAgent(provider: LlmProvider): Agent {
  const registry = new ToolRegistry([sampleTool]);
  const neo = makeFakeNeo4j() as unknown as Parameters<typeof Agent.prototype.ask>[0] extends never ? never : import('@ekg/graph').Neo4jClient;
  return new Agent({
    provider,
    tools: registry,
    planExecutor: {
      hybrid: makeFakeHybrid() as unknown as import('@ekg/search').HybridSearch,
      neo4j: neo as unknown as import('@ekg/graph').Neo4jClient,
    },
  });
}

describe('Agent.ask', () => {
  it('refuses immediately when retrieval is empty and no tools called', async () => {
    const provider = new ScriptedProvider([
      { content: '{"answer":"x","confidence":"HIGH","citations":[{"kind":"graph","ref":"made-up"}]}', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const agent = makeAgent(provider);
    const env = await agent.ask('What services depend on nothing?');
    expect(env.status).toBe('refused');
    expect(env.refused?.reason).toMatch(/REFUSE: no grounded retrieval/);
  });

  it('completes after a tool call and validates citation against seen ids', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'tc-1', name: 'sample.tool', arguments: { q: 'x' } }],
        stopReason: 'tool_use',
      },
      {
        content: '{"answer":"yes","confidence":"HIGH","citations":[{"kind":"graph","ref":"Sample:42"}]}',
        stopReason: 'end_turn',
      },
    ]);
    const agent = makeAgent(provider);
    const env = await agent.ask('Where is sample?');
    expect(env.status).toBe('ok');
    expect(env.answer?.answer).toBe('yes');
    expect(env.trace).toHaveLength(1);
    expect(env.trace[0]?.toolName).toBe('sample.tool');
  });

  it('rejects hallucinated citation, then refuses after one re-prompt', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'tc-1', name: 'sample.tool', arguments: { q: 'x' } }],
        stopReason: 'tool_use',
      },
      {
        content: '{"answer":"a","confidence":"HIGH","citations":[{"kind":"code","ref":"NotInSeen"}]}',
        stopReason: 'end_turn',
      },
      {
        content: '{"answer":"b","confidence":"LOW","citations":[{"kind":"code","ref":"StillNotInSeen"}]}',
        stopReason: 'end_turn',
      },
    ]);
    const agent = makeAgent(provider);
    const env = await agent.ask('Where is sample?');
    expect(env.status).toBe('refused');
    expect(env.refused?.reason).toMatch(/citation/);
  });

  it('caps tool iterations at 5', async () => {
    const looping: Partial<CompletionResponse> = {
      toolCalls: [{ id: 'tc', name: 'sample.tool', arguments: { q: 'x' } }],
      stopReason: 'tool_use',
    };
    // Provide 10 looping responses; agent should stop at iter 5.
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => looping));
    const agent = makeAgent(provider);
    const env = await agent.ask('loop forever');
    expect(env.status).toBe('refused');
    expect(env.usage.iterations).toBeLessThanOrEqual(5);
    expect(env.trace.length).toBeLessThanOrEqual(5);
  });
});
