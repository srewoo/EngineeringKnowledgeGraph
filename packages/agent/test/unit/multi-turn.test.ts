import { describe, it, expect } from 'vitest';
import { ScriptedProvider, makeSampleTool, buildAgent, InMemorySessionRepo } from './_helpers.js';

describe('Agent — multi-turn sessions', () => {
  it('round 2 sees prior history and seenIds', async () => {
    const sessions = new InMemorySessionRepo();
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    sessions.create(sessionId);

    const tool = makeSampleTool('mt.tool', 'MT:1');

    // Round 1: tool call then valid answer.
    const provider1 = new ScriptedProvider([
      { toolCalls: [{ id: 'tc-1', name: 'mt.tool', arguments: { q: 'first' } }], stopReason: 'tool_use' },
      { content: '{"answer":"first","confidence":"HIGH","citations":[{"kind":"graph","ref":"MT:1"}]}', stopReason: 'end_turn' },
    ]);
    const agent1 = buildAgent(provider1, [tool], sessions);
    const env1 = await agent1.ask('first question?', { sessionId });
    expect(env1.status).toBe('ok');
    expect(env1.sessionId).toBe(sessionId);

    // Persisted state should now have messages + seen ids.
    const persisted = sessions.get(sessionId);
    expect(persisted).toBeDefined();
    expect(persisted!.messages).toContain('first question');
    expect(persisted!.seenIds).toContain('MT:1');

    // Round 2: validates that prior seenIds are honoured by reusing MT:1
    // citation WITHOUT a tool call. The prior session's seenIds should
    // satisfy the citation check.
    const provider2 = new ScriptedProvider([
      { content: '{"answer":"second","confidence":"HIGH","citations":[{"kind":"graph","ref":"MT:1"}]}', stopReason: 'end_turn' },
    ]);
    const agent2 = buildAgent(provider2, [tool], sessions);
    const env2 = await agent2.ask('follow up?', { sessionId });
    expect(env2.status).toBe('ok');
    expect(env2.answer?.answer).toBe('second');
  });

  it('refuses when sessionId is unknown', async () => {
    const sessions = new InMemorySessionRepo();
    const tool = makeSampleTool();
    const provider = new ScriptedProvider([]);
    const agent = buildAgent(provider, [tool], sessions);
    const env = await agent.ask('hi', { sessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' });
    expect(env.status).toBe('refused');
    expect(env.refused?.reason).toMatch(/unknown sessionId/);
  });
});
