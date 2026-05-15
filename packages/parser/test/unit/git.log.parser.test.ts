import { describe, it, expect, vi } from 'vitest';
import { GitLogParser, parseGitLogOutput } from '../../src/git.log.parser.js';

const FIELD_SEP = '\x1F';
const COMMIT_MARKER = '__EKG_COMMIT__';

function buildLog(commits: Array<{
  sha: string; parents: string; author: string; email: string; date: string; subject: string; files: string[];
}>): string {
  return commits
    .map((c) => {
      const header = [
        `${COMMIT_MARKER}${c.sha}`, c.parents, c.author, c.email, c.date, c.subject,
      ].join(FIELD_SEP);
      const body = c.files.length > 0 ? '\n' + c.files.join('\n') : '';
      return header + body;
    })
    .join('\n');
}

describe('parseGitLogOutput', () => {
  it('returns empty result on empty input', () => {
    const out = parseGitLogOutput('');
    expect(out.commits).toHaveLength(0);
    expect(out.touchedFiles.size).toBe(0);
  });

  it('parses single commit with files', () => {
    const raw = buildLog([{
      sha: 'abc123', parents: '', author: 'Jane', email: 'j@x.com',
      date: '2026-01-01T00:00:00Z', subject: 'first', files: ['a.ts', 'b.ts'],
    }]);
    const out = parseGitLogOutput(raw);
    expect(out.commits).toHaveLength(1);
    expect(out.commits[0]?.sha).toBe('abc123');
    expect(out.commits[0]?.author).toBe('Jane');
    expect(out.commits[0]?.parentShas).toEqual([]);
    expect(out.touchedFiles.get('abc123')).toEqual(['a.ts', 'b.ts']);
  });

  it('parses multiple parents', () => {
    const raw = buildLog([{
      sha: 'm1', parents: 'p1 p2', author: 'A', email: 'a@x',
      date: '2026-01-01T00:00:00Z', subject: 'merge', files: [],
    }]);
    const out = parseGitLogOutput(raw);
    expect(out.commits[0]?.parentShas).toEqual(['p1', 'p2']);
  });

  it('truncates long commit messages to 500 chars', () => {
    const long = 'x'.repeat(1000);
    const raw = buildLog([{
      sha: 's1', parents: '', author: 'A', email: 'a@x',
      date: '2026-01-01T00:00:00Z', subject: long, files: ['f.ts'],
    }]);
    const out = parseGitLogOutput(raw);
    expect(out.commits[0]?.message.length).toBe(500);
  });

  it('handles commits with no files (empty file block)', () => {
    const raw = buildLog([{
      sha: 'empty1', parents: '', author: 'A', email: 'a@x',
      date: '2026-01-01T00:00:00Z', subject: 'no files', files: [],
    }]);
    const out = parseGitLogOutput(raw);
    expect(out.commits).toHaveLength(1);
    expect(out.touchedFiles.has('empty1')).toBe(false);
  });

  it('parses multiple commits in order', () => {
    const raw = buildLog([
      { sha: 's1', parents: '', author: 'A', email: 'a@x', date: '2026-01-02T00:00:00Z', subject: 'one', files: ['x.ts'] },
      { sha: 's2', parents: 's1', author: 'B', email: 'b@x', date: '2026-01-01T00:00:00Z', subject: 'two', files: ['y.ts', 'z.ts'] },
    ]);
    const out = parseGitLogOutput(raw);
    expect(out.commits.map((c) => c.sha)).toEqual(['s1', 's2']);
    expect(out.touchedFiles.get('s2')).toEqual(['y.ts', 'z.ts']);
  });
});

describe('GitLogParser (with injected git factory)', () => {
  it('honors --since, --max-count, --no-merges in raw args', async () => {
    const rawSpy = vi.fn().mockResolvedValue('');
    const parser = new GitLogParser(() => ({ raw: rawSpy } as never));
    await parser.parse('/tmp/repo', { since: '1 month ago', maxCommits: 50 });
    expect(rawSpy).toHaveBeenCalledOnce();
    const args = rawSpy.mock.calls[0]![0] as string[];
    expect(args).toContain('log');
    expect(args).toContain('--max-count=50');
    expect(args).toContain('--since=1 month ago');
    expect(args).toContain('--no-merges');
    expect(args).toContain('--name-only');
  });

  it('returns empty result when git fails', async () => {
    const parser = new GitLogParser(() => ({
      raw: vi.fn().mockRejectedValue(new Error('not a git repo')),
    } as never));
    const out = await parser.parse('/tmp/repo');
    expect(out.commits).toHaveLength(0);
  });

  it('returns empty result when maxCommits <= 0', async () => {
    const rawSpy = vi.fn();
    const parser = new GitLogParser(() => ({ raw: rawSpy } as never));
    const out = await parser.parse('/tmp/repo', { maxCommits: 0 });
    expect(out.commits).toHaveLength(0);
    expect(rawSpy).not.toHaveBeenCalled();
  });
});
