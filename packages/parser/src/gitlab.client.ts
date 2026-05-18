/**
 * GitLab API client — discovers repositories from GitLab groups.
 *
 * Uses the GitLab REST API (v4) to list all projects within
 * specified groups, including subgroups recursively.
 * Filters by repo size to skip oversized repositories.
 */

import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

export interface GitLabRepo {
  readonly id: number;
  readonly name: string;
  readonly fullPath: string;
  readonly httpUrl: string;
  readonly sshUrl: string;
  readonly defaultBranch: string;
  readonly repoSizeMb: number;
  readonly lastActivity: string;
  readonly archived: boolean;
}

export interface GitLabDiscoveryOptions {
  readonly gitlabUrl: string;
  readonly token: string;
  readonly groupIds: readonly number[];
  readonly maxRepoSizeMb: number;
  readonly includeArchived?: boolean;
}

interface GitLabProjectResponse {
  id: number;
  name: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch: string;
  statistics?: { repository_size?: number };
  last_activity_at: string;
  archived: boolean;
}

/** Token-bucket rate limiter — 10 req/s by default, with 429 backoff. */
class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }
  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefillMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.lastRefillMs = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil((1 - this.tokens) * 1000 / this.refillPerSec);
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }
}

export class GitLabClient {
  private readonly logger: Logger;
  private readonly limiter: RateLimiter;

  constructor() {
    this.logger = createLogger({ service: 'gitlab-client' });
    this.limiter = new RateLimiter(10, 10); // 10 req/s burst, 10/s refill
  }

  /**
   * Rate-limited fetch with 429 retry honouring Retry-After,
   * plus retries for transient network errors and 5xx responses.
   * At 1020-repo scale we cannot afford a single transient failure
   * to abort discovery — paginate-and-fail-loudly is too brittle.
   */
  private async rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        const response = await fetch(url, init);
        if (response.status === 429 && attempt < maxAttempts - 1) {
          const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1', 10);
          const waitMs = Math.max(1000, retryAfter * 1000) * Math.pow(2, attempt);
          this.logger.warn({ url, attempt, waitMs }, 'GitLab 429 — backing off');
          await new Promise((res) => setTimeout(res, waitMs));
          continue;
        }
        if (response.status >= 500 && response.status < 600 && attempt < maxAttempts - 1) {
          const waitMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
          this.logger.warn({ url, attempt, status: response.status, waitMs }, 'GitLab 5xx — retrying');
          await new Promise((res) => setTimeout(res, waitMs));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= maxAttempts - 1) throw error;
        const waitMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ url, attempt, error: message, waitMs }, 'GitLab fetch error — retrying');
        await new Promise((res) => setTimeout(res, waitMs));
      }
    }
    throw new Error(`Exhausted retries fetching ${url}`);
  }

  /**
   * Discover all repositories across specified GitLab groups.
   * Automatically paginates and filters by size.
   */
  async discoverRepos(options: GitLabDiscoveryOptions): Promise<readonly GitLabRepo[]> {
    const allRepos: GitLabRepo[] = [];

    for (const groupId of options.groupIds) {
      const repos = await this.getGroupProjects(
        options.gitlabUrl,
        options.token,
        groupId,
      );
      allRepos.push(...repos);
    }

    // Deduplicate by ID (repos can appear in multiple groups)
    const unique = this.deduplicateById(allRepos);

    // Filter by size
    const filtered = unique.filter((repo) => {
      if (repo.repoSizeMb > options.maxRepoSizeMb) {
        this.logger.warn({
          repo: repo.fullPath,
          sizeMb: repo.repoSizeMb,
          limitMb: options.maxRepoSizeMb,
        }, 'Skipping repo — exceeds size limit');
        return false;
      }
      return true;
    });

    // Archived repos are always filtered out — EKG only ingests active repos.
    // The includeArchived flag is intentionally ignored at this layer to make
    // it impossible for any caller to pull archived projects into the graph.
    void options.includeArchived;
    const result = filtered.filter((r) => !r.archived);

    this.logger.info({
      totalDiscovered: allRepos.length,
      afterDedup: unique.length,
      afterSizeFilter: filtered.length,
      afterArchiveFilter: result.length,
      maxSizeMb: options.maxRepoSizeMb,
    }, 'GitLab repo discovery completed');

    return result;
  }

  /**
   * Get the size of a single repo via the GitLab API.
   * Used for pre-clone size check.
   */
  async getRepoSize(
    gitlabUrl: string,
    token: string,
    projectPath: string,
  ): Promise<number> {
    const encodedPath = encodeURIComponent(projectPath);
    const url = `${gitlabUrl}/api/v4/projects/${encodedPath}?statistics=true`;

    const response = await this.rateLimitedFetch(url, {
      headers: { 'PRIVATE-TOKEN': token },
    });

    if (!response.ok) {
      this.logger.warn({ projectPath, status: response.status }, 'Failed to get repo size');
      return 0;
    }

    const project = await response.json() as GitLabProjectResponse;
    const sizeBytes = project.statistics?.repository_size ?? 0;
    return Math.round(sizeBytes / (1024 * 1024));
  }

  /**
   * Get all projects in a group, handling pagination.
   * Uses `include_subgroups=true` to discover nested groups.
   */
  private async getGroupProjects(
    gitlabUrl: string,
    token: string,
    groupId: number,
  ): Promise<GitLabRepo[]> {
    const repos: GitLabRepo[] = [];
    let page = 1;
    const perPage = 100;

    this.logger.info({ groupId }, 'Fetching projects for GitLab group');

    while (true) {
      const url = `${gitlabUrl}/api/v4/groups/${groupId}/projects?include_subgroups=true&statistics=true&per_page=${perPage}&page=${page}&order_by=last_activity_at&sort=desc`;

      let response: Response;
      try {
        response = await this.rateLimitedFetch(url, {
          headers: { 'PRIVATE-TOKEN': token },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ groupId, page, error: message }, 'GitLab API request exhausted retries — skipping page');
        page++;
        // Cap forward-skip so we don't loop forever on a permanently broken endpoint.
        if (page > 1000) break;
        continue;
      }

      if (!response.ok) {
        this.logger.error({
          groupId,
          page,
          status: response.status,
          statusText: response.statusText,
        }, 'GitLab API request failed — skipping page');
        // 4xx other than 429 (handled in rateLimitedFetch) won't be fixed by retry.
        if (response.status === 401 || response.status === 403 || response.status === 404) break;
        page++;
        if (page > 1000) break;
        continue;
      }

      const projects = await response.json() as GitLabProjectResponse[];

      if (projects.length === 0) break;

      for (const project of projects) {
        const sizeBytes = project.statistics?.repository_size ?? 0;
        repos.push({
          id: project.id,
          name: project.name,
          fullPath: project.path_with_namespace,
          httpUrl: project.http_url_to_repo,
          sshUrl: project.ssh_url_to_repo,
          defaultBranch: project.default_branch ?? 'main',
          repoSizeMb: Math.round(sizeBytes / (1024 * 1024)),
          lastActivity: project.last_activity_at,
          archived: project.archived,
        });
      }

      // Check if there are more pages
      const totalPages = parseInt(response.headers.get('x-total-pages') ?? '1', 10);
      if (page >= totalPages) break;
      page++;
    }

    this.logger.info({ groupId, projectCount: repos.length }, 'Group projects fetched');
    return repos;
  }

  /**
   * Authenticated GET against the GitLab v4 REST API. Returns the parsed
   * JSON body or throws on non-2xx. Exposed for tools that need to read
   * MR / pipeline / discussion data without rebuilding the rate-limit and
   * retry plumbing.
   */
  async apiGet<T = unknown>(
    gitlabUrl: string,
    token: string,
    apiPath: string,
  ): Promise<T> {
    const url = `${gitlabUrl}/api/v4${apiPath}`;
    const res = await this.rateLimitedFetch(url, {
      headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`GitLab GET ${apiPath} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private deduplicateById(repos: GitLabRepo[]): GitLabRepo[] {
    const seen = new Map<number, GitLabRepo>();
    for (const repo of repos) {
      if (!seen.has(repo.id)) {
        seen.set(repo.id, repo);
      }
    }
    return [...seen.values()];
  }
}
