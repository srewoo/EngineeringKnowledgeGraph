import { describe, it, expect } from 'vitest';
import { ScriptedProvider, makeSampleTool, buildAgent } from './_helpers.js';
import { makeStreamingAgent } from '../../src/agent.stream.js';

describe('Agent streaming wrapper', () => {
  it('yields tool lifecycle events and a final envelope', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'tc-1', name: 'sample.tool', arguments: { q: 'x' } }], stopReason: 'tool_use' },
      { content: '{"answer":"yes","confidence":"HIGH","citations":[{"kind":"graph","ref":"Sample:42"}]}', stopReason: 'end_turn' },
    ]);
    const agent = buildAgent(provider, [makeSampleTool()]);
    const streaming = makeStreamingAgent(agent);
    const events: string[] = [];
    let finalKind: string | undefined;
    for await (const evt of streaming.askStream('Where?')) {
      events.push(evt.kind);
      if (evt.kind === 'final') {
        finalKind = evt.envelope.status;
      }
    }
    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
    expect(events).toContain('text');
    expect(events[events.length - 1]).toBe('final');
    expect(finalKind).toBe('ok');
  });
});
