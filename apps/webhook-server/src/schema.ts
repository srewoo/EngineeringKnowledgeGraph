/**
 * Zod schema for the GitLab Push event subset we care about.
 *
 * GitLab sends a richer payload — we only validate what we use to enqueue
 * an incremental ingest. Unknown extra fields are accepted (zod default).
 */

import { z } from 'zod';

export const gitlabPushEventSchema = z.object({
  ref: z.string().min(1),
  before: z.string().min(1).optional(),
  after: z.string().min(1),
  total_commits_count: z.number().int().nonnegative(),
  project: z.object({
    path_with_namespace: z.string().min(1),
    web_url: z.string().url(),
    default_branch: z.string().min(1).optional(),
  }),
  commits: z
    .array(
      z.object({
        id: z.string().min(1),
        message: z.string().optional(),
      }),
    )
    .optional(),
});

export type GitlabPushEvent = z.infer<typeof gitlabPushEventSchema>;

const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * True when this push should be skipped (branch creation, no commits, or
 * tag-style refs that are not push-ingestable).
 */
export function shouldSkipPush(
  evt: GitlabPushEvent,
): { skip: true; reason: string } | { skip: false } {
  if (evt.before === ZERO_SHA) return { skip: true, reason: 'branch creation (before=zero)' };
  if (evt.total_commits_count === 0) return { skip: true, reason: 'zero commits' };
  if (!evt.ref.startsWith('refs/heads/'))
    return { skip: true, reason: `non-branch ref ${evt.ref}` };
  return { skip: false };
}

export function branchFromRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function repoUrlFromProject(webUrl: string): string {
  return webUrl.endsWith('.git') ? webUrl : `${webUrl}.git`;
}

/**
 * First-match-wins glob check against `path_with_namespace`. Empty pattern
 * list means "accept all".
 *
 * Globs are translated to anchored regex: `*` -> `[^/]*`, `**` -> `.*`,
 * `?` -> `.`. Everything else is regex-escaped.
 */
export function matchesAllowList(
  pathWithNamespace: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => globToRegex(p).test(pathWithNamespace));
}

export function parseAllowList(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function globToRegex(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '.';
      i += 1;
      continue;
    }
    out += (ch ?? '').replace(/[\\^$+.()|{}[\]]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}
