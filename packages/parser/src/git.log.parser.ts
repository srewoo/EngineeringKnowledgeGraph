/**
 * Git log parser (Phase 1.7) — captures the last N commits as `Commit` records
 * with the list of source files each commit touched.
 *
 * Implementation notes:
 *   - One `git log` shellout per repo. Custom `--pretty=format:` markers let us
 *     reconstruct each commit + its `--name-only` file list in a single pass.
 *   - Skips merge commits — a merge typically touches every file changed since
 *     branch-off and would inflate `TOUCHED` edges to noise.
 *   - Bounded by `maxCommits` and `--since` so it never dominates ingest time.
 *   - Defensive: shallow clones may have fewer commits than `maxCommits`; we
 *     simply take what's there. A failed `git log` returns an empty result —
 *     never throws into the ingest path.
 *
 * The `git` factory parameter is for tests — production passes `simpleGit`.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

const COMMIT_MARKER = '__EKG_COMMIT__';
const FIELD_SEP = '\x1F'; // ASCII record separator — unlikely in any commit field.

/** Default cap. Tunable via env in worker — see ingestion.service. */
export const DEFAULT_MAX_COMMITS = 1000;
export const DEFAULT_SINCE = '6 months ago';
const MESSAGE_TRUNCATE_BYTES = 500;

export interface ParsedCommit {
  readonly sha: string;
  readonly author: string;
  readonly authorEmail: string;
  readonly message: string;
  readonly authoredAt: string;
  readonly parentShas: readonly string[];
}

export interface GitLogResult {
  readonly commits: readonly ParsedCommit[];
  /** sha → array of file paths (repo-relative) touched by that commit. */
  readonly touchedFiles: ReadonlyMap<string, readonly string[]>;
}

export interface GitLogOptions {
  readonly since?: string;
  readonly maxCommits?: number;
}

export type GitFactory = (repoPath: string) => SimpleGit;

const defaultGitFactory: GitFactory = (repoPath) => simpleGit(repoPath);

export class GitLogParser {
  private readonly logger: Logger;
  private readonly gitFactory: GitFactory;

  constructor(gitFactory: GitFactory = defaultGitFactory) {
    this.logger = createLogger({ service: 'git-log-parser' });
    this.gitFactory = gitFactory;
  }

  async parse(repoPath: string, options: GitLogOptions = {}): Promise<GitLogResult> {
    const since = options.since ?? DEFAULT_SINCE;
    const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
    if (maxCommits <= 0) return { commits: [], touchedFiles: new Map() };

    let raw: string;
    try {
      const git = this.gitFactory(repoPath);
      const fmt = `${COMMIT_MARKER}%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%cI${FIELD_SEP}%s`;
      raw = await git.raw([
        'log',
        `--max-count=${maxCommits}`,
        `--since=${since}`,
        '--no-merges',
        '--no-renames',
        '--name-only',
        `--pretty=format:${fmt}`,
      ]);
    } catch (err) {
      this.logger.warn({ err, repoPath }, 'git log failed; skipping history');
      return { commits: [], touchedFiles: new Map() };
    }

    return parseGitLogOutput(raw);
  }
}

/**
 * Pure parser for our custom `git log` output. Exported for unit tests so
 * callers can mock the shellout but exercise the real parsing.
 */
export function parseGitLogOutput(raw: string): GitLogResult {
  const commits: ParsedCommit[] = [];
  const touched = new Map<string, string[]>();
  if (!raw) return { commits, touchedFiles: touched };

  const blocks = raw.split(COMMIT_MARKER);
  for (const block of blocks) {
    const trimmed = block.replace(/^\n+/, '');
    if (!trimmed) continue;
    const newlineAt = trimmed.indexOf('\n');
    const headerLine = newlineAt === -1 ? trimmed : trimmed.slice(0, newlineAt);
    const fileBlock = newlineAt === -1 ? '' : trimmed.slice(newlineAt + 1);

    const parts = headerLine.split(FIELD_SEP);
    if (parts.length < 6) continue;
    const [sha, parentsRaw, author, email, authoredAt, subject] = parts;
    if (!sha) continue;

    const parentShas = (parentsRaw ?? '').trim().split(/\s+/).filter(Boolean);
    const message = truncateMessage(subject ?? '');

    commits.push({
      sha,
      author: author ?? '',
      authorEmail: email ?? '',
      message,
      authoredAt: authoredAt ?? '',
      parentShas,
    });

    const files: string[] = [];
    for (const line of fileBlock.split('\n')) {
      const path = line.trim();
      if (path) files.push(path);
    }
    if (files.length > 0) touched.set(sha, files);
  }

  return { commits, touchedFiles: touched };
}

function truncateMessage(input: string): string {
  if (input.length <= MESSAGE_TRUNCATE_BYTES) return input;
  return input.slice(0, MESSAGE_TRUNCATE_BYTES);
}
