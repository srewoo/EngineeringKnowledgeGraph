/**
 * MCP Tool: gitlab_get_mr — fetch a merge request with enough context to
 * support a release-confidence review.
 *
 * Returns:
 *   - MR metadata (title, state, source/target branches, author, draft, WIP,
 *     mergeable, milestone, labels, web_url, sha)
 *   - Diff stats (per-file added/removed lines, renames, new/deleted)
 *   - Discussion notes (latest 30, redacted)
 *   - Pipelines for the source branch (latest 5 with status + duration)
 *   - Approvals (rules, approvers, approved/required)
 *   - Risk heuristics: large diff, no approvals yet, failing pipeline,
 *     touches infra/migrations/Helm/CI, breaking-change keyword
 *
 * Auth uses the same `GIT_TOKEN` the rest of EKG already needs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitLabClient } from '@ekg/parser';
import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'tool.gitlab_get_mr' });

const MR_URL_RE =
  /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;

interface ParsedMrUrl {
  readonly gitlabUrl: string;
  readonly projectPath: string;
  readonly mrIid: number;
}

export interface GitlabGetMrDeps {
  readonly gitlabUrl: string;
  readonly token: string;
}

export function registerGitlabGetMrTool(server: McpServer, deps: GitlabGetMrDeps): void {
  server.tool(
    'gitlab_get_mr',
    'Fetch a GitLab merge request with diff stats, discussions, pipelines, approvals, and rollout-risk heuristics. Accepts a full MR URL, or projectPath+iid.',
    {
      url: z.string().optional().describe('Full MR URL, e.g. https://gitlab.com/group/project/-/merge_requests/123'),
      projectPath: z.string().optional().describe('Namespace/project path. Required if `url` is omitted.'),
      iid: z.number().int().positive().optional().describe('MR iid (project-relative). Required if `url` is omitted.'),
      maxDiscussions: z.number().int().min(0).max(100).default(30),
    },
    async ({ url, projectPath, iid, maxDiscussions }) => {
      if (!deps.token) {
        return errOut('GIT_TOKEN not set — cannot call GitLab API.');
      }

      let parsed: ParsedMrUrl;
      if (url) {
        const m = MR_URL_RE.exec(url);
        if (!m) return errOut(`Could not parse MR URL: ${url}`);
        parsed = { gitlabUrl: m[1]!, projectPath: m[2]!, mrIid: Number(m[3]!) };
      } else if (projectPath && iid) {
        parsed = { gitlabUrl: deps.gitlabUrl, projectPath, mrIid: iid };
      } else {
        return errOut('Provide either `url` or both `projectPath` and `iid`.');
      }

      const client = new GitLabClient();
      const enc = encodeURIComponent(parsed.projectPath);
      const base = `/projects/${enc}/merge_requests/${parsed.mrIid}`;

      try {
        const [mr, changes, discussions, pipelines, approvals] = await Promise.all([
          client.apiGet<MrPayload>(parsed.gitlabUrl, deps.token, base),
          client.apiGet<MrChangesPayload>(parsed.gitlabUrl, deps.token, `${base}/changes`),
          client.apiGet<MrDiscussion[]>(parsed.gitlabUrl, deps.token, `${base}/discussions?per_page=${Math.min(100, maxDiscussions)}`).catch(() => [] as MrDiscussion[]),
          client.apiGet<MrPipeline[]>(parsed.gitlabUrl, deps.token, `${base}/pipelines`).catch(() => [] as MrPipeline[]),
          client.apiGet<MrApprovals>(parsed.gitlabUrl, deps.token, `${base}/approvals`).catch(() => undefined),
        ]);

        const summary = summarise(mr, changes, discussions.slice(0, maxDiscussions), pipelines.slice(0, 5), approvals);
        logger.info({ mr: parsed.mrIid, project: parsed.projectPath }, 'gitlab_get_mr');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errOut(`gitlab_get_mr failed: ${msg}`);
      }
    },
  );
}

// ---- Types we actually consume from the API ----

interface MrPayload {
  id: number;
  iid: number;
  state: string;
  title: string;
  description: string | null;
  source_branch: string;
  target_branch: string;
  author?: { username?: string; name?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  user_notes_count?: number;
  milestone?: { title?: string } | null;
  labels?: string[];
  web_url: string;
  sha?: string;
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string };
  created_at?: string;
  updated_at?: string;
}

interface MrChangesPayload {
  changes_count?: string;
  changes?: Array<{
    old_path: string;
    new_path: string;
    new_file?: boolean;
    deleted_file?: boolean;
    renamed_file?: boolean;
    diff?: string;
  }>;
}

interface MrDiscussion {
  id: string;
  notes?: Array<{
    id: number;
    body?: string;
    author?: { username?: string };
    created_at?: string;
    resolvable?: boolean;
    resolved?: boolean;
  }>;
}

interface MrPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at?: string;
  updated_at?: string;
}

interface MrApprovals {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: Array<{ user?: { username?: string } }>;
}

// ---- Summarisation + risk heuristics ----

const RISK_PATH_PATTERNS: ReadonlyArray<{ tag: string; re: RegExp }> = [
  { tag: 'migration',  re: /(^|\/)(migrations?|db\/migrations?|schema|liquibase|flyway)\// },
  { tag: 'helm',       re: /(^|\/)(helm|charts?|deploy|values\.ya?ml)/i },
  { tag: 'k8s',        re: /(^|\/)(k8s|kubernetes|manifests?)\//i },
  { tag: 'ci',         re: /\.gitlab-ci\.ya?ml|\.github\/workflows\// },
  { tag: 'dockerfile', re: /(^|\/)Dockerfile($|\.)/ },
  { tag: 'terraform',  re: /\.tf$/ },
  { tag: 'secrets',    re: /(^|\/)(secrets?|vault|\.env)/i },
];

const BREAKING_KEYWORDS = ['breaking change', 'BREAKING CHANGE', 'force-push', '!:', 'remove api', 'rename column'];

interface DiffStats {
  filesChanged: number;
  added: number;
  removed: number;
  newFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  byTag: Record<string, number>;
  topFiles: Array<{ path: string; added: number; removed: number; tags: string[] }>;
}

function summarise(
  mr: MrPayload,
  changes: MrChangesPayload,
  discussions: MrDiscussion[],
  pipelines: MrPipeline[],
  approvals: MrApprovals | undefined,
) {
  const stats = computeDiffStats(changes);
  const latestPipeline = pipelines[0];

  const risks: string[] = [];
  if (stats.filesChanged > 50) risks.push(`large MR: ${stats.filesChanged} files changed`);
  if (stats.added + stats.removed > 1500) risks.push(`large diff: +${stats.added}/-${stats.removed} lines`);
  if (mr.draft || mr.work_in_progress) risks.push('MR is still a draft / WIP');
  if (mr.has_conflicts) risks.push('has merge conflicts');
  if (latestPipeline && /failed|canceled/.test(latestPipeline.status)) risks.push(`latest pipeline status=${latestPipeline.status}`);
  if (approvals && (approvals.approvals_left ?? 0) > 0) risks.push(`approvals_left=${approvals.approvals_left}`);
  if (approvals && (approvals.approved_by?.length ?? 0) === 0) risks.push('no approvers yet');
  for (const tag of Object.keys(stats.byTag)) {
    if (stats.byTag[tag]! > 0) risks.push(`touches ${tag} (${stats.byTag[tag]} file${stats.byTag[tag]! > 1 ? 's' : ''})`);
  }
  const corpus = `${mr.title}\n${mr.description ?? ''}`;
  for (const kw of BREAKING_KEYWORDS) {
    if (corpus.toLowerCase().includes(kw.toLowerCase())) {
      risks.push(`description mentions "${kw}"`);
      break;
    }
  }

  return {
    mr: {
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      author: mr.author?.username ?? mr.author?.name ?? 'unknown',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      draft: mr.draft ?? mr.work_in_progress ?? false,
      mergeStatus: mr.detailed_merge_status ?? mr.merge_status ?? 'unknown',
      hasConflicts: mr.has_conflicts ?? false,
      labels: mr.labels ?? [],
      milestone: mr.milestone?.title ?? null,
      webUrl: mr.web_url,
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? null,
      createdAt: mr.created_at ?? null,
      updatedAt: mr.updated_at ?? null,
    },
    diff: stats,
    pipelines: pipelines.map((p) => ({
      id: p.id,
      status: p.status,
      ref: p.ref,
      sha: p.sha,
      webUrl: p.web_url,
      createdAt: p.created_at,
    })),
    approvals: approvals
      ? {
          required: approvals.approvals_required ?? 0,
          left: approvals.approvals_left ?? 0,
          approvers: (approvals.approved_by ?? []).map((a) => a.user?.username).filter(Boolean) as string[],
        }
      : null,
    discussions: discussions.flatMap((d) =>
      (d.notes ?? []).slice(0, 1).map((n) => ({
        author: n.author?.username ?? 'unknown',
        createdAt: n.created_at,
        resolvable: n.resolvable ?? false,
        resolved: n.resolved ?? false,
        excerpt: (n.body ?? '').slice(0, 240),
      })),
    ),
    risks,
  };
}

function computeDiffStats(changes: MrChangesPayload): DiffStats {
  const out: DiffStats = {
    filesChanged: 0,
    added: 0,
    removed: 0,
    newFiles: 0,
    deletedFiles: 0,
    renamedFiles: 0,
    byTag: {},
    topFiles: [],
  };
  const list = changes.changes ?? [];
  out.filesChanged = list.length;
  const fileStats: Array<{ path: string; added: number; removed: number; tags: string[] }> = [];
  for (const c of list) {
    if (c.new_file) out.newFiles++;
    if (c.deleted_file) out.deletedFiles++;
    if (c.renamed_file) out.renamedFiles++;
    const { added, removed } = countDiffLines(c.diff ?? '');
    out.added += added;
    out.removed += removed;
    const path = c.new_path || c.old_path;
    const tags: string[] = [];
    for (const p of RISK_PATH_PATTERNS) {
      if (p.re.test(path)) {
        tags.push(p.tag);
        out.byTag[p.tag] = (out.byTag[p.tag] ?? 0) + 1;
      }
    }
    fileStats.push({ path, added, removed, tags });
  }
  fileStats.sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  out.topFiles = fileStats.slice(0, 15);
  return out;
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function errOut(msg: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}
