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
    let effectiveBranch = branch;
    try {
      await this.runClone(git, url, localPath, effectiveBranch);
    } catch (err) {
      // Some repos default to master / develop / something else. If the
      // requested branch doesn't exist, probe the remote HEAD and retry
      // with whatever Git reports as the default. Bounded to one fallback
      // attempt — if that also fails, surface the original error.
      if (!isMissingBranchError(err)) throw err;
      const fallback = await this.resolveRemoteHead(url, signal);
      if (!fallback || fallback === branch) throw err;
      this.logger.warn(
        { url: url.replace(/\/\/.*@/, '//***@'), requested: branch, fallback },
        'Requested branch missing — retrying with remote HEAD',
      );
      // Make sure the partial clone directory (if any) is gone.
      await rm(localPath, { recursive: true, force: true });
      effectiveBranch = fallback;
      await this.runClone(git, url, localPath, effectiveBranch);
    }

    // Post-clone: remove bloat directories that shouldn't be in git but sometimes are
    await this.cleanupBloat(localPath);

    const repoGit = simpleGit(localPath);
    const log = await repoGit.log({ maxCount: 1 });
    const currentSha = log.latest?.hash ?? '';

    this.logger.info({ localPath, sha: currentSha, branch: effectiveBranch }, 'Clone completed');

    return {
      localPath,
      currentSha,
      isNewClone: true,
      changedFiles: [],
    };
  }

  private async runClone(
    git: SimpleGit,
    url: string,
    localPath: string,
    branch: string,
  ): Promise<void> {
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
  }

  /**
   * Ask the remote for its HEAD branch (`git ls-remote --symref <url> HEAD`).
   * Returns the branch name (e.g. "master") or undefined on any failure.
   * Used as a fallback when the requested branch isn't present.
   */
  private async resolveRemoteHead(
    url: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const git = signal ? simpleGit({ abort: signal }) : simpleGit();
    try {
      const out = await git.raw(['ls-remote', '--symref', url, 'HEAD']);
      // Format: "ref: refs/heads/master\tHEAD\n<sha>\tHEAD\n"
      const m = /^ref:\s+refs\/heads\/(\S+)/m.exec(out);
      return m?.[1];
    } catch (err) {
      this.logger.warn(
        { url: url.replace(/\/\/.*@/, '//***@'), err: errMsg(err) },
        'ls-remote HEAD probe failed',
      );
      return undefined;
    }
  }

  private async pullExisting(
    localPath: string,
    branch: string,
    previousSha?: string,
    signal?: AbortSignal,
  ): Promise<CloneResult> {
    this.logger.info({ localPath, branch }, 'Pulling existing repository');

    const git = signal ? simpleGit(localPath, { abort: signal }) : simpleGit(localPath);

    // Detect the actual default branch in case the requested one no longer
    // exists on the remote. Reuse the local working copy for ls-remote so we
    // pick up the right `origin` URL (with whatever auth Git already has).
    let effectiveBranch = branch;
    const doFetch = async (target: string): Promise<void> => {
      try {
        await git.raw(['-c', `pack.threads=${PACK_THREADS}`, 'fetch', 'origin', target, '--depth', '50', '--no-tags']);
      } catch (e) {
        if (isMissingBranchError(e)) throw e;
        await git.raw(['-c', `pack.threads=${PACK_THREADS}`, 'fetch', 'origin', target, '--no-tags']);
      }
    };
    const checkoutAndPull = async (target: string): Promise<void> => {
      await git.checkout(target);
      await git.pull('origin', target);
    };

    // Probe origin HEAD up front when the requested branch is "main" — most
    // older mindtickle repos default to master/develop and we save a round-
    // trip by detecting that before attempting fetch/checkout.
    const origin = await this.resolveOriginHead(localPath, signal);
    if (origin && origin !== branch) {
      // Verify the requested branch exists on origin; if not, prefer HEAD.
      const remoteRefs = await this.lsRemoteBranchExists(localPath, branch, signal);
      if (!remoteRefs) {
        this.logger.warn(
          { localPath, requested: branch, fallback: origin },
          'Requested branch missing on origin — using remote HEAD',
        );
        effectiveBranch = origin;
      }
    }

    try {
      await doFetch(effectiveBranch);
      await checkoutAndPull(effectiveBranch);
    } catch (err) {
      if (!isMissingBranchError(err)) throw err;
      // Fall back to whatever origin actually advertises as HEAD.
      const remoteHead = origin ?? (await this.resolveOriginHead(localPath, signal));
      if (!remoteHead || remoteHead === effectiveBranch) throw err;
      this.logger.warn(
        { localPath, requested: effectiveBranch, fallback: remoteHead },
        'Branch fetch/checkout failed — retrying with remote HEAD',
      );
      effectiveBranch = remoteHead;
      await doFetch(effectiveBranch);
      await checkoutAndPull(effectiveBranch);
    }

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

  /**
   * Variant of resolveRemoteHead that uses an existing working copy's
   * `origin` remote — avoids leaking tokens through ls-remote args.
   */
  private async resolveOriginHead(
    localPath: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const git = signal ? simpleGit(localPath, { abort: signal }) : simpleGit(localPath);
    try {
      const out = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
      const m = /^ref:\s+refs\/heads\/(\S+)/m.exec(out);
      return m?.[1];
    } catch (err) {
      this.logger.warn({ localPath, err: errMsg(err) }, 'ls-remote origin HEAD probe failed');
      return undefined;
    }
  }

  /** True when `branch` exists on origin. */
  private async lsRemoteBranchExists(
    localPath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const git = signal ? simpleGit(localPath, { abort: signal }) : simpleGit(localPath);
    try {
      const out = await git.raw(['ls-remote', '--heads', 'origin', branch]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * True when a Git error indicates the requested branch / ref doesn't exist
 * on the remote. Covers both clone-time and fetch-time variants.
 */
function isMissingBranchError(err: unknown): boolean {
  const msg = errMsg(err).toLowerCase();
  return (
    msg.includes("couldn't find remote ref") ||
    msg.includes('did not match any file') ||
    msg.includes('remote branch') && msg.includes('not found') ||
    msg.includes("couldn't find a branch")
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
