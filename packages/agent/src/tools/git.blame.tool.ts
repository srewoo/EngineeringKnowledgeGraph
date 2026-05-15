/**
 * git.blame — `git -C <repoPath> blame -L <line>,<line> <relPath>`.
 *
 * Refuses if `repoPath` is not inside `data/repos/`. Uses node's child_process —
 * we keep this package free of `simple-git` to limit dep weight in the agent.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

const TIMEOUT_MS = 10_000;
const RESULT_TEXT_CAP = 4000;

const inputSchema = z.object({
  repoPath: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
});
type Input = z.infer<typeof inputSchema>;

export interface GitBlameOptions {
  /** Directory under which `repoPath` must resolve. Defaults to `<cwd>/data/repos`. */
  readonly reposRoot?: string;
}

export function buildGitBlameTool(opts: GitBlameOptions = {}): AgentTool<Input> {
  const reposRoot = path.resolve(opts.reposRoot ?? path.join(process.cwd(), 'data', 'repos'));

  return {
    name: 'git.blame',
    description:
      'git blame for a single line range in a file inside the local repo cache. ' +
      'Returns commit, author, and date for the requested lines.',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Path to a repo inside data/repos/.' },
        filePath: { type: 'string', description: 'Repo-relative path to the file.' },
        line: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['repoPath', 'filePath', 'line'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const repoAbs = ensureUnderRoot(input.repoPath, reposRoot);
      const fileAbs = ensureUnderRoot(path.resolve(repoAbs, input.filePath), repoAbs);
      const fileRel = path.relative(repoAbs, fileAbs);
      const start = input.line;
      const end = input.endLine ?? input.line;
      if (end < start) throw new Error('git.blame refused: endLine < line');

      const args = ['-C', repoAbs, 'blame', '-L', `${start},${end}`, '--porcelain', '--', fileRel];
      const out = await runGit(args);
      const text = truncate(out, RESULT_TEXT_CAP);
      return {
        text,
        seenIds: [`${fileRel}:${start}-${end}`],
        raw: { repoPath: repoAbs, filePath: fileRel, start, end },
      };
    },
  };
}

function ensureUnderRoot(input: string, root: string): string {
  const resolved = path.resolve(input);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`git.blame refused: '${input}' is outside ${root}`);
  }
  return resolved;
}

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git blame timed out after ${TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git blame exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n[truncated ${s.length - cap} chars]`;
}
