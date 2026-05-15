import { describe, it, expect } from 'vitest';
import { ScriptedProvider, makeSampleTool, buildAgent } from './_helpers.js';
import { Agent } from '../../src/agent.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { LlmProvider } from '../../src/provider.interface.js';

describe('Agent — budget gate', () => {
  it('refuses with BUDGET_EXCEEDED when token budget is tiny', async () => {
    // Each completion reports 100 in / 100 out → 200 tokens.
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'a', name: 'sample.tool', arguments: { q: 'x' } }],
        stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 100 } },
      { toolCalls: [{ id: 'b', name: 'sample.tool', arguments: { q: 'x' } }],
        stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 100 } },
      { content: '{"answer":"ok","confidence":"HIGH","citations":[{"kind":"graph","ref":"Sample:42"}]}',
        stopReason: 'end_turn' },
    ]);
    const tool = makeSampleTool();
    const registry = new ToolRegistry([tool]);
    const agent = new Agent({
      provider,
      tools: registry,
      planExecutor: {
        hybrid: { async search() { return []; } } as unknown as import('@ekg/search').HybridSearch,
        neo4j: {
          async executeRead<T>(work: (tx: { run: () => Promise<{ records: never[] }> }) => Promise<T>) {
            return work({ run: async () => ({ records: [] }) });
          },
        } as unknown as import('@ekg/graph').Neo4jClient,
      },
      budgetLimits: { maxTokens: 250, maxUsd: 100, maxToolCalls: 100 },
    });
    const env = await agent.ask('budget test', { maxTokens: 250 });
    expect(env.status).toBe('refused');
    expect(env.refused?.reason).toMatch(/BUDGET_EXCEEDED/);
    expect(env.refused?.reason).toMatch(/tokens=/);
  });

  it('refuses when USD budget is tripped (Anthropic Sonnet pricing)', async () => {
    // 100k tokens against Sonnet input price ~ $0.30 — easy to trip a $0.001 cap.
    const provider: LlmProvider = {
      id: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      async complete() {
        return {
          content: '{"answer":"ok","confidence":"HIGH","citations":[{"kind":"graph","ref":"Sample:42"}]}',
          toolCalls: [],
          usage: { inputTokens: 100_000, outputTokens: 0 },
          stopReason: 'end_turn',
        };
      },
    };
    const agent = buildAgent(provider, [makeSampleTool()]);
    // Override budget via constructor: cheaper to reconstruct.
    const tight = new Agent({
      provider,
      tools: new ToolRegistry([makeSampleTool()]),
      planExecutor: {
        hybrid: { async search() { return []; } } as unknown as import('@ekg/search').HybridSearch,
        neo4j: {
          async executeRead<T>(work: (tx: { run: () => Promise<{ records: never[] }> }) => Promise<T>) {
            return work({ run: async () => ({ records: [] }) });
          },
        } as unknown as import('@ekg/graph').Neo4jClient,
      },
      budgetLimits: { maxTokens: 1_000_000, maxUsd: 0.001, maxToolCalls: 100 },
    });
    // First iter is allowed (state starts at 0); after consuming 100k tokens
    // the second iter check trips. To exercise, queue one more iteration:
    void agent;
    // Second provider response triggers a second loop iteration where the
    // budget check runs against the now-accumulated cost.
    let calls = 0;
    const seqProvider: LlmProvider = {
      id: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [{ id: 't', name: 'sample.tool', arguments: { q: 'x' } }],
            usage: { inputTokens: 100_000, outputTokens: 0 },
            stopReason: 'tool_use',
          };
        }
        return {
          content: '{"answer":"ok","confidence":"HIGH","citations":[{"kind":"graph","ref":"Sample:42"}]}',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        };
      },
    };
    const tightSeq = new Agent({
      provider: seqProvider,
      tools: new ToolRegistry([makeSampleTool()]),
      planExecutor: {
        hybrid: { async search() { return []; } } as unknown as import('@ekg/search').HybridSearch,
        neo4j: {
          async executeRead<T>(work: (tx: { run: () => Promise<{ records: never[] }> }) => Promise<T>) {
            return work({ run: async () => ({ records: [] }) });
          },
        } as unknown as import('@ekg/graph').Neo4jClient,
      },
      budgetLimits: { maxTokens: 1_000_000, maxUsd: 0.001, maxToolCalls: 100 },
    });
    const env = await tightSeq.ask('cost test');
    expect(env.status).toBe('refused');
    expect(env.refused?.reason).toMatch(/BUDGET_EXCEEDED/);
    expect(env.refused?.reason).toMatch(/cost=/);
    void tight;
  });
});
