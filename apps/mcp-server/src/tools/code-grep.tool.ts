/**
 * MCP Tool: code_grep — literal/regex search over locally-cloned repos.
 *
 * Walks `${DATA_DIR}/repos/<repo>/` directories on disk and greps file
 * content. EKG's graph indexes structure, not raw text — this tool fills
 * the "find every `INSERT IGNORE` in Go" gap.
 *
 * Bounds (hard, non-negotiable):
 *  - max 5,000 files visited per call
 *  - max 2 MB per file (matches EKG's source-file cap)
 *  - max 500 matches returned
 *  - 30s wall-clock budget
 *  - skips DEFAULT_IGNORE_DIRS + binary extensions
 *  - regex must compile; no catastrophic-backtracking guard so callers
 *    are advised to anchor patterns
 */

import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BINARY_AND_LIBRARY_EXTENSIONS, MAX_SOURCE_FILE_BYTES, createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'tool.code_grep' });

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  'vendor', 'target', '.gradle', '.idea', '.vscode', '__pycache__',
]);

const MAX_FILES = 5_000;
const MAX_MATCHES = 500;
const TIME_BUDGET_MS = 30_000;

const LANG_EXT_MAP: Readonly<Record<string, readonly string[]>> = {
  go: ['.go'],
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi'],
  py: ['.py', '.pyi'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
  ruby: ['.rb'],
  rust: ['.rs'],
  csharp: ['.cs'],
  php: ['.php'],
  sql: ['.sql', '.ddl'],
  yaml: ['.yaml', '.yml'],
  json: ['.json'],
  md: ['.md', '.mdx'],
};

interface Match {
  readonly repo: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface CodeGrepDeps {
  readonly dataDir: string;
}

export function registerCodeGrepTool(server: McpServer, deps: CodeGrepDeps): void {
  server.tool(
    'code_grep',
    'Literal or regex text search over locally-cloned repos under DATA_DIR/repos/. Use for SQL strings, error codes, env-var names, or any pattern not modelled in the graph. Bounded: max 5,000 files, 500 matches, 30s.',
    {
      pattern: z.string().min(1).describe('Search pattern. Treated as a JS regex unless `literal: true`.'),
      literal: z.boolean().default(false).describe('When true, escape regex metacharacters and do a literal substring match.'),
      caseInsensitive: z.boolean().default(true).describe('Case-insensitive match (default true).'),
      repos: z.array(z.string()).optional().describe('Restrict to these repo dir names (matched by basename of repos/<dir>). Omit to search all cloned repos.'),
      languages: z.array(z.string()).optional().describe(`Restrict by language: ${Object.keys(LANG_EXT_MAP).join('|')}. Omit to scan every supported source extension.`),
      pathGlob: z.string().optional().describe('Optional substring that must appear in the file path (e.g. "internal/" or "models/"). Substring, not glob, for simplicity.'),
      maxResults: z.number().int().min(1).max(MAX_MATCHES).default(100).describe(`Max matches to return (capped at ${MAX_MATCHES}).`),
    },
    async ({ pattern, literal, caseInsensitive, repos, languages, pathGlob, maxResults }) => {
      const reposRoot = resolve(deps.dataDir, 'repos');
      try {
        await stat(reposRoot);
      } catch {
        return errOut(`No cloned repos at ${reposRoot}. Run ingest_repo or bulk_ingest first.`);
      }

      let regex: RegExp;
      try {
        const source = literal ? escapeRegex(pattern) : pattern;
        regex = new RegExp(source, caseInsensitive ? 'i' : '');
      } catch (err) {
        return errOut(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }

      const allowedExts = collectExtensions(languages);
      const repoFilter = repos && repos.length > 0 ? new Set(repos) : undefined;

      const matches: Match[] = [];
      const startedAt = Date.now();
      let filesVisited = 0;
      let filesTooLarge = 0;
      let truncated = false;

      const repoDirs = await safeReaddir(reposRoot);
      for (const repoEntry of repoDirs) {
        if (!repoEntry.isDirectory()) continue;
        if (repoFilter && !repoFilter.has(repoEntry.name)) continue;
        const repoRoot = join(reposRoot, repoEntry.name);

        const stack: string[] = [repoRoot];
        while (stack.length > 0) {
          if (Date.now() - startedAt > TIME_BUDGET_MS) { truncated = true; break; }
          if (matches.length >= Math.min(maxResults, MAX_MATCHES)) { truncated = true; break; }
          if (filesVisited >= MAX_FILES) { truncated = true; break; }
          const dir = stack.pop()!;
          const entries = await safeReaddir(dir);
          for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
              if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
              stack.push(full);
              continue;
            }
            if (!e.isFile()) continue;
            const ext = extname(e.name).toLowerCase();
            if (BINARY_AND_LIBRARY_EXTENSIONS.has(ext)) continue;
            if (allowedExts && !allowedExts.has(ext)) continue;
            const rel = relative(repoRoot, full);
            if (pathGlob && !rel.includes(pathGlob)) continue;

            filesVisited++;
            let st;
            try { st = await stat(full); } catch { continue; }
            if (st.size > MAX_SOURCE_FILE_BYTES) { filesTooLarge++; continue; }
            let content: string;
            try { content = await readFile(full, 'utf8'); } catch { continue; }

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              if (regex.test(line)) {
                matches.push({
                  repo: repoEntry.name,
                  file: rel,
                  line: i + 1,
                  text: line.length > 240 ? `${line.slice(0, 240)}…` : line,
                });
                if (matches.length >= Math.min(maxResults, MAX_MATCHES)) { truncated = true; break; }
              }
            }
            if (truncated) break;
          }
          if (truncated) break;
        }
        if (truncated) break;
      }

      const summary = {
        pattern,
        literal,
        caseInsensitive,
        ...(repos ? { repos } : {}),
        ...(languages ? { languages } : {}),
        ...(pathGlob ? { pathGlob } : {}),
        filesVisited,
        filesTooLarge,
        matchCount: matches.length,
        truncated,
        durationMs: Date.now() - startedAt,
        matches,
      };
      logger.info({ pattern, matchCount: matches.length, filesVisited, durationMs: summary.durationMs }, 'code_grep');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}

function collectExtensions(languages: readonly string[] | undefined): Set<string> | undefined {
  if (!languages || languages.length === 0) return undefined;
  const out = new Set<string>();
  for (const lang of languages) {
    const exts = LANG_EXT_MAP[lang.toLowerCase()];
    if (exts) for (const e of exts) out.add(e);
    else if (lang.startsWith('.')) out.add(lang.toLowerCase());
  }
  return out.size > 0 ? out : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function safeReaddir(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function errOut(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
