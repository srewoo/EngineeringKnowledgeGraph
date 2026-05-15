/**
 * GitHub API client — discovers repositories from a user or organisation.
 *
 * Mirrors the GitLabClient interface so BulkIngestionService can use either.
 * Honours rate limit headers and supports paginated discovery.
 */

import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';
import type { GitLabRepo } from './gitlab.client.js';

export interface GitHubDiscoveryOptions {
  readonly githubUrl?: string; // e.g. https://api.github.com
  readonly token: string;
  readonly orgs?: readonly string[];
  readonly users?: readonly string[];
  readonly maxRepoSizeMb: number;
  readonly includeArchived?: boolean;
  readonly includeForks?: boolean;
}

interface GitHubRepoResponse {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  size: number; // KB
  pushed_at: string;
  archived: boolean;
  fork: boolean;
}

export class GitHubClient {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'github-client' });
  }

  async discoverRepos(options: GitHubDiscoveryOptions): Promise<readonly GitLabRepo[]> {
    const base = options.githubUrl ?? 'https://api.github.com';
    const all: GitLabRepo[] = [];

    for (const org of options.orgs ?? []) {
      const repos = await this.fetchPaged(`${base}/orgs/${org}/repos`, options.token);
      all.push(...repos.map((r) => this.toRepo(r)));
    }
    for (const user of options.users ?? []) {
      const repos = await this.fetchPaged(`${base}/users/${user}/repos`, options.token);
      all.push(...repos.map((r) => this.toRepo(r)));
    }

    const dedup = this.dedupe(all);
    const filtered = dedup.filter((r) => {
      if (r.repoSizeMb > options.maxRepoSizeMb) {
        this.logger.warn({ repo: r.fullPath, sizeMb: r.repoSizeMb, limitMb: options.maxRepoSizeMb }, 'Skipping repo — exceeds size limit');
        return false;
      }
      return true;
    });
    // Archived repos are always filtered out — EKG only ingests active repos.
    void options.includeArchived;
    const final = filtered.filter((r) => !r.archived);

    this.logger.info({
      totalDiscovered: all.length,
      afterDedup: dedup.length,
      afterSizeFilter: filtered.length,
      afterArchiveFilter: final.length,
    }, 'GitHub repo discovery completed');
    return final;
  }

  private async fetchPaged(url: string, token: string): Promise<GitHubRepoResponse[]> {
    const out: GitHubRepoResponse[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const paged = `${url}?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`;
      const response = await this.rateAwareFetch(paged, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) {
        this.logger.error({ url: paged, status: response.status }, 'GitHub API request failed');
        break;
      }
      const repos = await response.json() as GitHubRepoResponse[];
      out.push(...repos);
      if (repos.length < perPage) break;
      page++;
    }
    return out;
  }

  private async rateAwareFetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (remaining === '0' && reset) {
        const waitMs = Math.max(1000, parseInt(reset, 10) * 1000 - Date.now());
        this.logger.warn({ url, waitMs }, 'GitHub rate limit hit — waiting for reset');
        await new Promise((res) => setTimeout(res, Math.min(waitMs, 60_000)));
        return fetch(url, init);
      }
    }
    return response;
  }

  private toRepo(r: GitHubRepoResponse): GitLabRepo & { archived: boolean } {
    return {
      id: r.id,
      name: r.name,
      fullPath: r.full_name,
      httpUrl: r.clone_url,
      sshUrl: r.ssh_url,
      defaultBranch: r.default_branch ?? 'main',
      repoSizeMb: Math.round((r.size ?? 0) / 1024), // GitHub size is KB
      lastActivity: r.pushed_at,
      archived: r.archived,
    };
  }

  private dedupe(repos: GitLabRepo[]): GitLabRepo[] {
    const seen = new Map<number, GitLabRepo>();
    for (const r of repos) if (!seen.has(r.id)) seen.set(r.id, r);
    return [...seen.values()];
  }
}
