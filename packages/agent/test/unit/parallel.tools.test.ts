import { describe, it, expect } from 'vitest';
import { ScriptedProvider, makeSampleTool, buildAgent } from './_helpers.js';

describe('Agent — parallel tool calls', () => {
  it('dispatches 3 tools in one turn and merges results', async () => {
    let invoked = 0;
    const slowTool = {
      ...makeSampleTool('slow.tool', 'Slow:1'),
      async invoke(input: { q: string }) {
        invoked += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { text: `slow ${input.q}`, seenIds: ['Slow:1'] };
      },
    };
    const fastTool = {
      ...makeSampleTool('fast.tool', 'Fast:1'),
      async invoke(input: { q: string }) {
        invoked += 1;
        return { text: `fast ${input.q}`, seenIds: ['Fast:1'] };
      },
    };
    const errTool = {
      ...makeSampleTool('err.tool', 'Err:1'),
      async invoke() {
        invoked += 1;
        throw new Error('boom');
      },
    };

    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'slow.tool', arguments: { q: 'x' } },
          { id: 'b', name: 'fast.tool', arguments: { q: 'y' } },
          { id: 'c', name: 'err.tool', arguments: { q: 'z' } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: '{"answer":"ok","confidence":"HIGH","citations":[{"kind":"graph","ref":"Slow:1"}]}',
        stopReason: 'end_turn',
      },
    ]);
    const agent = buildAgent(provider, [slowTool, fastTool, errTool]);
    const t0 = Date.now();
    const env = await agent.ask('multi tool');
    const dur = Date.now() - t0;
    expect(env.status).toBe('ok');
    expect(invoked).toBe(3);
    // Three traces in same turn
    const turn1Traces = env.trace.filter((t) => t.turn === 1);
    expect(turn1Traces).toHaveLength(3);
    expect(turn1Traces.find((t) => t.toolName === 'err.tool')?.ok).toBe(false);
    // Parallel: total wall < 30ms (slowTool is 10ms; serial would be ~30+)
    // Allow a generous bound to avoid flake on CI.
    expect(dur).toBeLessThan(2000);
  });
});
