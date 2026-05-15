/**
 * MCP Tool: eval_run — runs the eval harness end-to-end.
 *
 * Always available, even when the agent is disabled — retrieval-only eval is
 * still useful for classifier accuracy regression. When `useAgent=false` (or
 * the agent stack is unavailable) the runner reports zero citation metrics.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createLogger } from '@ekg/shared';
import { runEval, loadCasesFromFile, type EvalAgent, type EvalAgentResult } from '@ekg/eval';

export interface EvalRunDeps {
  /** Optional pre-built agent. If absent or `useAgent=false`, runs retrieval-only. */
  readonly buildAgent?: () => EvalAgent | null;
}

function defaultCasesPath(): string {
  // Ship the bundled scaffold; resolve relative to this compiled tool file.
  const here = dirname(fileURLToPath(import.meta.url));
  // dist tool path: apps/mcp-server/dist/tools/eval-run.tool.js
  // bundled cases at: packages/eval/eval-set/cases.json (relative monorepo)
  const candidates = [
    resolve(here, '..', '..', '..', '..', 'packages', 'eval', 'eval-set', 'cases.json'),
    resolve(process.cwd(), 'packages', 'eval', 'eval-set', 'cases.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function registerEvalRunTool(server: McpServer, deps: EvalRunDeps = {}): void {
  const logger = createLogger({ service: 'eval-run-tool' });

  server.tool(
    'eval_run',
    'Run the EKG eval harness against the bundled (or supplied) eval cases. Returns aggregate metrics. Per-case JSONL traces are written under data/eval/<runId>/.',
    {
      casesPath: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
      useAgent: z.boolean().optional(),
    },
    async ({ casesPath, limit, useAgent }) => {
      try {
        const path = casesPath ?? defaultCasesPath();
        if (!existsSync(path)) {
          return { content: [{ type: 'text' as const, text: `eval_run refused: cases not found at ${path}` }], isError: true };
        }
        const cases = loadCasesFromFile(path);
        const agent = useAgent === false ? null : (deps.buildAgent ? deps.buildAgent() : null);
        const opts = { ...(limit !== undefined ? { limit } : {}) };
        const { run } = await runEval(cases, agent, opts);
        logger.info({ runId: run.runId, cases: run.cases }, 'eval run completed');
        return { content: [{ type: 'text' as const, text: JSON.stringify(run, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'eval_run failed');
        return { content: [{ type: 'text' as const, text: `eval_run failed: ${msg}` }], isError: true };
      }
    },
  );
}

// Compile-time assertion — keep result shape stable.
const _evalAgentType: EvalAgentResult = { status: 'refused', citations: [], refuseReason: '' };
void _evalAgentType;
