/**
 * Agent tool contract. Each tool is a small file exporting an `AgentTool`
 * factory. The registry validates inputs against the tool's Zod schema before
 * `invoke` is ever called.
 */

import type { z } from 'zod';

export interface SeenIds {
  add(id: string): void;
  has(id: string): boolean;
  values(): readonly string[];
}

export interface ToolInvocationResult {
  /** Compact text representation handed back to the LLM. */
  readonly text: string;
  /** Stable IDs of nodes/files referenced by the tool result. */
  readonly seenIds: readonly string[];
  /** Optional structured payload — included in the trace, not in LLM context. */
  readonly raw?: unknown;
}

export interface AgentTool<TInput extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TInput>;
  /** JSON Schema (fed to provider's `tools` field). */
  readonly jsonSchema: Record<string, unknown>;
  invoke(input: TInput): Promise<ToolInvocationResult>;
}

export class SeenIdSet implements SeenIds {
  private readonly set = new Set<string>();
  add(id: string): void { if (id) this.set.add(id); }
  has(id: string): boolean { return this.set.has(id); }
  values(): readonly string[] { return Array.from(this.set); }
  size(): number { return this.set.size; }
}
