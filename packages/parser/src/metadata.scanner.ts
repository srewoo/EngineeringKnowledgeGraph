/**
 * Repository metadata scanner.
 *
 * Extracts non-code, non-config signal that's expensive to query at runtime
 * but cheap to read once at ingestion time:
 *
 *   - CODEOWNERS (GitHub / GitLab) → Owner / Team nodes with OWNS edges
 *   - Latest commit timestamp per repo (from git log)
 *
 * No per-file git blame — that's prohibitively slow on large repos. The repo's
 * latest commit timestamp on each File node is enough for "stale code" queries.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

export interface CodeOwnerRule {
  /** Glob pattern from CODEOWNERS, e.g. "/apps/web/" or "*.ts". */
  readonly pattern: string;
  /** Owner names — usernames (@user) or teams (@org/team). */
  readonly owners: readonly string[];
}

export interface RepoMetadata {
  readonly latestCommitAt?: string;
  readonly latestCommitSha?: string;
  readonly codeOwners: readonly CodeOwnerRule[];
  /** Per-file last-changed timestamp (ISO-8601). Best-effort. */
  readonly fileLastChangedAt: ReadonlyMap<string, string>;
}

export class MetadataScanner {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'metadata-scanner' });
  }

  async scan(repoDir: string): Promise<RepoMetadata> {
    const [latest, codeOwners, fileLastChangedAt] = await Promise.all([
      this.getLatestCommit(repoDir),
      this.parseCodeOwners(repoDir),
      this.getFileLastChanged(repoDir),
    ]);
    this.logger.info({
      repoDir,
      ownerRules: codeOwners.length,
      latestCommitAt: latest?.date,
      filesWithHistory: fileLastChangedAt.size,
    }, 'Metadata scan completed');
    return {
      latestCommitAt: latest?.date,
      latestCommitSha: latest?.sha,
      codeOwners,
      fileLastChangedAt,
    };
  }

  /**
   * Single-pass `git log` over the entire repo. We walk commits newest → oldest
   * and record the first time each file appears (which is its most-recent
   * change). Bounded at 5000 commits so this stays fast on huge histories.
   */
  private async getFileLastChanged(repoDir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const git = simpleGit(repoDir);
      // Format: per-commit ISO date line, then the changed file paths.
      const raw = await git.raw([
        'log',
        '--max-count=5000',
        '--name-only',
        '--no-renames',
        '--no-merges',
        '--format=__COMMIT__%cI',
      ]);
      let currentDate: string | undefined;
      for (const line of raw.split('\n')) {
        if (line.startsWith('__COMMIT__')) {
          currentDate = line.slice('__COMMIT__'.length).trim() || undefined;
          continue;
        }
        const path = line.trim();
        if (!path || !currentDate) continue;
        if (!out.has(path)) out.set(path, currentDate);
      }
    } catch {
      // git may not be available (e.g. test fixtures) — best-effort
    }
    return out;
  }

  private async getLatestCommit(
    repoDir: string,
  ): Promise<{ sha: string; date: string } | undefined> {
    try {
      const git = simpleGit(repoDir);
      const log = await git.log({ maxCount: 1 });
      const latest = log.latest;
      if (!latest) return undefined;
      return { sha: latest.hash, date: latest.date };
    } catch {
      return undefined;
    }
  }

  private async parseCodeOwners(repoDir: string): Promise<readonly CodeOwnerRule[]> {
    const candidates = [
      'CODEOWNERS',
      '.github/CODEOWNERS',
      '.gitlab/CODEOWNERS',
      'docs/CODEOWNERS',
    ];

    for (const candidate of candidates) {
      const path = join(repoDir, candidate);
      if (!(await this.exists(path))) continue;

      const content = await readFile(path, 'utf-8').catch(() => '');
      if (!content) continue;

      const rules: CodeOwnerRule[] = [];
      for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        const pattern = parts[0];
        const owners = parts.slice(1).filter((p) => p.startsWith('@') || p.includes('@'));
        if (!pattern || owners.length === 0) continue;
        rules.push({ pattern, owners });
      }
      return rules;
    }
    return [];
  }

  /**
   * Match a file path against CODEOWNERS rules. Returns owners from the LAST
   * matching rule (CODEOWNERS spec: later rules win).
   */
  static resolveOwners(
    relativePath: string,
    rules: readonly CodeOwnerRule[],
  ): readonly string[] {
    let matched: readonly string[] = [];
    for (const rule of rules) {
      if (this.matchesPattern(relativePath, rule.pattern)) {
        matched = rule.owners;
      }
    }
    return matched;
  }

  /**
   * CODEOWNERS glob matcher per GitHub spec:
   *   - bare `*` matches anything (including path separators) when used alone
   *   - `*.ext` matches any file ending in .ext anywhere in the tree
   *   - `dir/*.ext` is anchored
   *   - `/dir/` and `dir/` match a directory prefix
   *   - `**` is a multi-segment wildcard
   */
  private static matchesPattern(path: string, pattern: string): boolean {
    const p = path.replace(/^\/+/, '');

    // Single "*" — matches everything
    if (pattern === '*') return true;

    // Trailing-slash directory prefix
    if (pattern.endsWith('/')) {
      const dir = pattern.replace(/^\/+/, '');
      return p.startsWith(dir);
    }

    const isAnchored = pattern.startsWith('/');
    let pat = pattern.replace(/^\/+/, '');

    // Convert glob to regex
    const regexBody = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLESTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLESTAR::/g, '.*');

    if (isAnchored) {
      const re = new RegExp('^' + regexBody + '$');
      return re.test(p);
    }
    // Unanchored — match anywhere along the path. We allow the pattern to
    // match the trailing basename (typical for "*.ts").
    const reFull = new RegExp('^' + regexBody + '$');
    if (reFull.test(p)) return true;
    const lastSegment = p.split('/').pop() ?? '';
    const reSegment = new RegExp('^' + regexBody + '$');
    return reSegment.test(lastSegment);
  }

  private async exists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch { return false; }
  }
}
