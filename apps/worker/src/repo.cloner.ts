/**
 * Repo cloner — clones or pulls Git repositories.
 *
 * Manages local repo cache in data/repos/ directory.
 * Uses shallow clone + treeless filter to minimize disk usage.
 * Detects changes via commit SHA comparison.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import { access, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { availableParallelism } from 'node:os';
import { createLogger, DEFAULT_IGNORE_DIRS } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

/**
 * `pack.threads` controls how many threads Git uses to decompress pack
 * objects on clone. Default is 1; set to CPU count to parallelize.
 * Must be passed via `-c` BEFORE the subcommand (e.g. `git -c pack.threads=N clone`).
 */
const PACK_THREADS = String(availableParallelism());

export interface CloneResult {
  readonly localPath: string;
  readonly currentSha: string;
  readonly previousSha?: string;
  readonly isNewClone: boolean;
  readonly changedFiles: readonly string[];
}

export class RepoCloner {
  private readonly dataDir: string;
  private readonly logger: Logger;

  constructor(dataDir: string) {
    this.dataDir = join(dataDir, 'repos');
    this.logger = createLogger({ service: 'repo-cloner' });
  }

  /**
   * Clone a repo (or pull if already exists). Returns changed files list.
   * Pass an AbortSignal to allow callers to cancel a stuck clone/pull.
   */
  async cloneOrPull(
    repoUrl: string,
    branch: string,
    token?: string,
    previousSha?: string,
    signal?: AbortSignal,
  ): Promise<CloneResult> {
    await mkdir(this.dataDir, { recursive: true });

    const repoName = this.extractRepoName(repoUrl);
    const localPath = join(this.dataDir, repoName);
    const authenticatedUrl = token ? this.injectToken(repoUrl, token) : repoUrl;

    const isExisting = await this.exists(join(localPath, '.git'));

    if (isExisting) {
      return this.pullExisting(localPath, branch, previousSha, signal);
    }

    return this.cloneNew(authenticatedUrl, localPath, branch, signal);
  }

  private async cloneNew(
    url: string,
    localPath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<CloneResult> {
    this.logger.info({ url: url.replace(/\/\/.*@/, '//***@'), branch }, 'Cloning repository');

    const git = signal ? simpleGit({ abort: signal }) : simpleGit();
    // Use raw() so `-c pack.threads=N` lands before `clone` (per-invocation config).
    await git.raw([
      '-c', `pack.threads=${PACK_THREADS}`,
      'clone',
      '--branch', branch,
      '--single-branch',
      '--depth', '1',                    // Only latest commit
      '--no-tags',                        // Skip tag refs (Mindtickle repos have many)
      '--filter=blob:limit=2m',           // Skip blobs >2MB (images, binaries, lockfiles)
      url,
      localPath,
    ]);

    // Post-clone: remove bloat directories that shouldn't be in git but sometimes are
    await this.cleanupBloat(localPath);

    const repoGit = simpleGit(localPath);
    const log = await repoGit.log({ maxCount: 1 });
    const currentSha = log.latest?.hash ?? '';

    this.logger.info({ localPath, sha: currentSha }, 'Clone completed');

    return {
      localPath,
      currentSha,
      isNewClone: true,
      changedFiles: [],
    };
  }

  private async pullExisting(
    localPath: string,
    branch: string,
    previousSha?: string,
    signal?: AbortSignal,
  ): Promise<CloneResult> {
    this.logger.info({ localPath, branch }, 'Pulling existing repository');

    const git = signal ? simpleGit(localPath, { abort: signal }) : simpleGit(localPath);

    // Unshallow if needed for diff (only fetches the delta)
    try {
      await git.raw(['-c', `pack.threads=${PACK_THREADS}`, 'fetch', 'origin', branch, '--depth', '50', '--no-tags']);
    } catch {
      await git.raw(['-c', `pack.threads=${PACK_THREADS}`, 'fetch', 'origin', branch, '--no-tags']);
    }

    await git.checkout(branch);
    await git.pull('origin', branch);

    const log = await git.log({ maxCount: 1 });
    const currentSha = log.latest?.hash ?? '';

    let changedFiles: string[] = [];
    if (previousSha && previousSha !== currentSha) {
      try {
        const diff = await git.diffSummary([previousSha, currentSha]);
        changedFiles = diff.files.map((f) => f.file);
      } catch {
        // If previousSha is not reachable (pruned by shallow), treat as full change
        this.logger.warn({ previousSha }, 'Previous SHA not reachable — treating as full change');
        changedFiles = [];
      }
    }

    this.logger.info({
      localPath,
      currentSha,
      previousSha,
      changedFiles: changedFiles.length,
    }, 'Pull completed');

    return {
      localPath,
      currentSha,
      previousSha,
      isNewClone: false,
      changedFiles,
    };
  }

  /**
   * Remove directories that waste disk and shouldn't be in git.
   * Some repos accidentally commit node_modules, vendor, dist, etc.
   */
  private async cleanupBloat(localPath: string): Promise<void> {
    const bloatDirs = [
      'node_modules', 'vendor', 'dist', 'build', '.next', '.nuxt',
      '.cache', '__pycache__', '.gradle', '.m2', 'target',
      'coverage', '.terraform', '.output',
    ];

    for (const dir of bloatDirs) {
      const fullPath = join(localPath, dir);
      if (await this.exists(fullPath)) {
        this.logger.warn({ dir }, 'Removing bloat directory from clone');
        await rm(fullPath, { recursive: true, force: true });
      }
    }
  }

  private injectToken(url: string, token: string): string {
    if (url.startsWith('https://')) {
      return url.replace('https://', `https://oauth2:${token}@`);
    }
    return url;
  }

  private extractRepoName(url: string): string {
    const match = /\/([^/]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ?? 'unknown-repo';
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
