/**
 * Tool registry — central entry point used by the agent loop.
 *
 * - Validates inputs against each tool's Zod schema before `invoke`.
 * - Rejects unknown tools with a structured error.
 * - Exposes the JSON-schema list for the provider's `tools` field.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';
import type { ToolSpec } from '../provider.interface.js';

export interface RegistryInvokeResult {
  readonly ok: boolean;
  readonly result?: ToolInvocationResult;
  readonly error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly logger: Logger;

  constructor(tools: readonly AgentTool[]) {
    this.logger = createLogger({ service: 'agent-tool-registry' });
    for (const t of tools) {
      if (this.tools.has(t.name)) {
        throw new Error(`ToolRegistry: duplicate tool name '${t.name}'`);
      }
      this.tools.set(t.name, t as AgentTool);
    }
  }

  list(): readonly AgentTool[] {
    return Array.from(this.tools.values());
  }

  specs(): readonly ToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(name: string, rawArgs: Record<string, unknown>): Promise<RegistryInvokeResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn({ name }, 'Unknown tool invocation rejected');
      return { ok: false, error: `unknown tool: ${name}` };
    }
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ');
      this.logger.warn({ name, msg }, 'Tool input validation failed');
      return { ok: false, error: `invalid arguments: ${msg}` };
    }
    try {
      const result = await tool.invoke(parsed.data as Record<string, unknown>);
      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ name, err: msg }, 'Tool invocation threw');
      return { ok: false, error: msg };
    }
  }
}
