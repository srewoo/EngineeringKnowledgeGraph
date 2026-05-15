/**
 * code.read — read a file from the repo cache, with strict path-traversal
 * protection and a hard line cap (200 lines).
 *
 * Refuses anything resolving outside `<reposRoot>` (default `data/repos/`).
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

export const MAX_LINES = 200;
const RESULT_TEXT_CAP = 16_000;

const inputSchema = z
  .object({
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
  })
  .refine(
    (v) => v.lineStart === undefined || v.lineEnd === undefined || v.lineEnd >= v.lineStart,
    { message: 'lineEnd must be >= lineStart', path: ['lineEnd'] },
  );
type Input = z.infer<typeof inputSchema>;

export interface CodeReadOptions {
  /** Directory under which all reads must resolve. Defaults to `<cwd>/data/repos`. */
  readonly reposRoot?: string;
}

export function buildCodeReadTool(opts: CodeReadOptions = {}): AgentTool<Input> {
  const reposRoot = path.resolve(opts.reposRoot ?? path.join(process.cwd(), 'data', 'repos'));

  return {
    name: 'code.read',
    description:
      `Read up to ${MAX_LINES} lines from a source file in the local repo cache. ` +
      'Refuses paths outside data/repos/.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative or absolute file path under data/repos/.' },
        lineStart: { type: 'integer', minimum: 1 },
        lineEnd: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const resolved = resolveSafe(input.path, reposRoot);
      const buf = await fs.readFile(resolved, 'utf8');
      const lines = buf.split(/\r?\n/);
      const start = Math.max(1, input.lineStart ?? 1);
      const requestedEnd = input.lineEnd ?? lines.length;
      const cappedEnd = Math.min(requestedEnd, start + MAX_LINES - 1, lines.length);
      const slice = lines.slice(start - 1, cappedEnd);
      const truncated = cappedEnd < requestedEnd;
      const body = slice
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n');
      const text = truncate(
        `# ${path.relative(reposRoot, resolved)} (lines ${start}-${cappedEnd}${truncated ? ', truncated' : ''})\n${body}`,
        RESULT_TEXT_CAP,
      );
      return {
        text,
        seenIds: [path.relative(reposRoot, resolved)],
        raw: { path: path.relative(reposRoot, resolved), start, end: cappedEnd, truncated },
      };
    },
  };
}

export function resolveSafe(input: string, reposRoot: string): string {
  const root = path.resolve(reposRoot);
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`code.read refused: path outside repos root (${reposRoot})`);
  }
  if (rel.split(path.sep).includes('..')) {
    throw new Error('code.read refused: path traversal detected');
  }
  return candidate;
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n[truncated ${s.length - cap} chars]`;
}
