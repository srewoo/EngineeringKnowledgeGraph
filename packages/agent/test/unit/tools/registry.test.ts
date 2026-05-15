import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { AgentTool } from '../../../src/tools/tool.interface.js';

const echoTool: AgentTool<{ msg: string }> = {
  name: 'echo',
  description: 'echo',
  schema: z.object({ msg: z.string().min(1) }),
  jsonSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  async invoke(input) {
    return { text: `echo:${input.msg}`, seenIds: [`echo:${input.msg}`] };
  },
};

const throwTool: AgentTool<Record<string, unknown>> = {
  name: 'throws',
  description: 't',
  schema: z.object({}),
  jsonSchema: { type: 'object' },
  async invoke() { throw new Error('boom'); },
};

describe('ToolRegistry', () => {
  it('rejects unknown tool', async () => {
    const r = new ToolRegistry([echoTool]);
    const res = await r.invoke('does-not-exist', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown tool/);
  });

  it('rejects invalid input', async () => {
    const r = new ToolRegistry([echoTool]);
    const res = await r.invoke('echo', { msg: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid arguments/);
  });

  it('passes valid input through', async () => {
    const r = new ToolRegistry([echoTool]);
    const res = await r.invoke('echo', { msg: 'hi' });
    expect(res.ok).toBe(true);
    expect(res.result?.text).toBe('echo:hi');
  });

  it('captures throws as error result', async () => {
    const r = new ToolRegistry([throwTool]);
    const res = await r.invoke('throws', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });

  it('rejects duplicate tool names at construction', () => {
    expect(() => new ToolRegistry([echoTool, echoTool])).toThrow(/duplicate/);
  });

  it('exposes specs', () => {
    const r = new ToolRegistry([echoTool]);
    const specs = r.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe('echo');
  });
});
