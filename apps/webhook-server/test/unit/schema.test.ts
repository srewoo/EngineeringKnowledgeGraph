import { describe, it, expect } from 'vitest';
import {
  branchFromRef,
  matchesAllowList,
  parseAllowList,
  repoUrlFromProject,
  shouldSkipPush,
  gitlabPushEventSchema,
} from '../../src/schema.js';

describe('schema helpers', () => {
  it('extracts branch name from refs/heads/...', () => {
    expect(branchFromRef('refs/heads/main')).toBe('main');
    expect(branchFromRef('refs/heads/feat/foo')).toBe('feat/foo');
    expect(branchFromRef('refs/tags/v1')).toBe('refs/tags/v1');
  });

  it('appends .git only when missing', () => {
    expect(repoUrlFromProject('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b.git');
    expect(repoUrlFromProject('https://gitlab.com/a/b.git')).toBe('https://gitlab.com/a/b.git');
  });

  it('parses comma-separated allow list, trimming and dropping blanks', () => {
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList('')).toEqual([]);
    expect(parseAllowList(' a/b , c/* ,, ')).toEqual(['a/b', 'c/*']);
  });

  it('matches glob patterns against namespace', () => {
    expect(matchesAllowList('org/svc', [])).toBe(true); // empty = accept all
    expect(matchesAllowList('org/svc', ['org/*'])).toBe(true);
    expect(matchesAllowList('org/sub/svc', ['org/*'])).toBe(false);
    expect(matchesAllowList('org/sub/svc', ['org/**'])).toBe(true);
    expect(matchesAllowList('other/svc', ['org/*'])).toBe(false);
    expect(matchesAllowList('org/svc-1', ['org/svc-?'])).toBe(true);
  });

  it('skips branch creation, zero-commit, and non-branch refs', () => {
    const base = {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      total_commits_count: 1,
      project: { path_with_namespace: 'o/s', web_url: 'https://gitlab.com/o/s' },
    } as const;
    expect(shouldSkipPush(base).skip).toBe(false);
    expect(shouldSkipPush({ ...base, before: '0'.repeat(40) }).skip).toBe(true);
    expect(shouldSkipPush({ ...base, total_commits_count: 0 }).skip).toBe(true);
    expect(shouldSkipPush({ ...base, ref: 'refs/tags/v1' }).skip).toBe(true);
  });

  it('validates gitlab push payload', () => {
    const ok = gitlabPushEventSchema.safeParse({
      ref: 'refs/heads/main',
      after: 'deadbeef',
      total_commits_count: 1,
      project: { path_with_namespace: 'o/s', web_url: 'https://gitlab.com/o/s' },
    });
    expect(ok.success).toBe(true);
    const bad = gitlabPushEventSchema.safeParse({ ref: '', after: '', total_commits_count: -1 });
    expect(bad.success).toBe(false);
  });
});
