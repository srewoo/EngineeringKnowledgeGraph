/**
 * History post-extraction pass (Phase 1.7).
 *
 * Two slices, both opt-in for git-log:
 *   1. CODEOWNERS — already parsed by `MetadataScanner`; here we re-walk the
 *      rules across ALL emitted File nodes and emit per-file `OWNED_BY` edges
 *      with rich Owner / Team properties.
 *   2. Git log — `Commit -[TOUCHED]-> File` edges for the last N commits.
 *      Gated by `EKG_GIT_HISTORY_ENABLED=true` to keep ingest latency stable.
 *
 * Designed to fail soft: any error logs and returns an empty result.
 */

import { createLogger } from '@ekg/shared';
import type { GraphNode, GraphRelationship, Logger, CommitNode } from '@ekg/shared';
import {
  MetadataScanner,
  GitLogParser,
  DEFAULT_MAX_COMMITS,
  DEFAULT_SINCE,
} from '@ekg/parser';
import { CodeownersExtractor } from '@ekg/extractor';

export interface HistoryPassInput {
  readonly repoUrl: string;
  readonly localPath: string;
  readonly nodes: readonly GraphNode[];
}

export interface HistoryPassResult {
  readonly newNodes: readonly GraphNode[];
  readonly newRelationships: readonly GraphRelationship[];
  readonly stats: Readonly<{
    ownerCount: number;
    teamCount: number;
    ownsEdges: number;
    commitCount: number;
    touchedEdges: number;
    skippedTouchedEdges: number;
  }>;
}

const EMPTY_RESULT: HistoryPassResult = {
  newNodes: [],
  newRelationships: [],
  stats: {
    ownerCount: 0, teamCount: 0, ownsEdges: 0,
    commitCount: 0, touchedEdges: 0, skippedTouchedEdges: 0,
  },
};

export class HistoryPass {
  private readonly logger: Logger;
  private readonly metadataScanner: MetadataScanner;
  private readonly codeownersExtractor: CodeownersExtractor;
  private readonly gitLogParser: GitLogParser;

  constructor() {
    this.logger = createLogger({ service: 'history-pass' });
    this.metadataScanner = new MetadataScanner();
    this.codeownersExtractor = new CodeownersExtractor();
    this.gitLogParser = new GitLogParser();
  }

  async run(input: HistoryPassInput): Promise<HistoryPassResult> {
    const fileIndex = this.indexFiles(input.nodes);
    if (fileIndex.size === 0) return EMPTY_RESULT;

    const ownership = await this.runCodeowners(input, fileIndex);
    const history = await this.runGitLog(input, fileIndex);

    return {
      newNodes: [...ownership.nodes, ...history.nodes],
      newRelationships: [...ownership.rels, ...history.rels],
      stats: {
        ownerCount: ownership.ownerCount,
        teamCount: ownership.teamCount,
        ownsEdges: ownership.rels.length,
        commitCount: history.commitCount,
        touchedEdges: history.rels.length,
        skippedTouchedEdges: history.skipped,
      },
    };
  }

  /** Build (relativePath → fileId) lookup from the extraction output. */
  private indexFiles(nodes: readonly GraphNode[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const n of nodes) {
      if (n.label !== 'File') continue;
      const path = (n.properties as { path?: string }).path;
      if (!path) continue;
      // Last writer wins is fine — File ids are deduped upstream.
      out.set(path, n.id);
    }
    return out;
  }

  private async runCodeowners(
    input: HistoryPassInput,
    fileIndex: Map<string, string>,
  ): Promise<{ nodes: GraphNode[]; rels: GraphRelationship[]; ownerCount: number; teamCount: number }> {
    try {
      const meta = await this.metadataScanner.scan(input.localPath);
      if (meta.codeOwners.length === 0) {
        return { nodes: [], rels: [], ownerCount: 0, teamCount: 0 };
      }
      const repoFiles = [...fileIndex.entries()].map(([relativePath, fileId]) => ({
        fileId, relativePath,
      }));
      const result = this.codeownersExtractor.extract({
        rules: meta.codeOwners,
        repoUrl: input.repoUrl,
        repoFiles,
      });
      this.logger.info({
        repoUrl: input.repoUrl,
        owners: result.owners.length,
        teams: result.teams.length,
        edges: result.relationships.length,
      }, 'CODEOWNERS pass complete');
      return {
        nodes: [...result.owners, ...result.teams],
        rels: [...result.relationships],
        ownerCount: result.owners.length,
        teamCount: result.teams.length,
      };
    } catch (err) {
      this.logger.warn({ err, repoUrl: input.repoUrl }, 'CODEOWNERS pass failed (continuing)');
      return { nodes: [], rels: [], ownerCount: 0, teamCount: 0 };
    }
  }

  private async runGitLog(
    input: HistoryPassInput,
    fileIndex: Map<string, string>,
  ): Promise<{ nodes: GraphNode[]; rels: GraphRelationship[]; commitCount: number; skipped: number }> {
    if (!isGitHistoryEnabled()) {
      this.logger.debug({ repoUrl: input.repoUrl }, 'git history disabled (EKG_GIT_HISTORY_ENABLED!=true)');
      return { nodes: [], rels: [], commitCount: 0, skipped: 0 };
    }
    const since = process.env['EKG_GIT_HISTORY_SINCE'] ?? DEFAULT_SINCE;
    const maxCommits = parsePositiveInt(process.env['EKG_GIT_HISTORY_MAX_COMMITS'], DEFAULT_MAX_COMMITS);

    try {
      const startedAt = Date.now();
      const log = await this.gitLogParser.parse(input.localPath, { since, maxCommits });

      const nodes: GraphNode[] = [];
      const rels: GraphRelationship[] = [];
      let skipped = 0;

      for (const commit of log.commits) {
        const id = `${input.repoUrl}#${commit.sha}`;
        const node: CommitNode = {
          id,
          label: 'Commit',
          name: commit.sha.slice(0, 12),
          properties: {
            sha: commit.sha,
            repoUrl: input.repoUrl,
            author: commit.author,
            authorEmail: commit.authorEmail,
            message: commit.message,
            authoredAt: commit.authoredAt,
            parentShas: commit.parentShas,
          },
        };
        nodes.push(node);

        const files = log.touchedFiles.get(commit.sha) ?? [];
        for (const path of files) {
          const fileId = fileIndex.get(path);
          if (!fileId) { skipped += 1; continue; }
          rels.push({
            type: 'TOUCHED',
            sourceId: id,
            targetId: fileId,
            confidence: 'HIGH',
            properties: { authoredAt: commit.authoredAt },
          });
        }
      }

      this.logger.info({
        repoUrl: input.repoUrl,
        commits: log.commits.length,
        touchedEdges: rels.length,
        skipped,
        durationMs: Date.now() - startedAt,
      }, 'git history pass complete');

      return { nodes, rels, commitCount: log.commits.length, skipped };
    } catch (err) {
      this.logger.warn({ err, repoUrl: input.repoUrl }, 'git history pass failed (continuing)');
      return { nodes: [], rels: [], commitCount: 0, skipped: 0 };
    }
  }
}

function isGitHistoryEnabled(): boolean {
  return (process.env['EKG_GIT_HISTORY_ENABLED'] ?? '').toLowerCase() === 'true';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
