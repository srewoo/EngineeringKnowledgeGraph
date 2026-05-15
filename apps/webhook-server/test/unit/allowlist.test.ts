import { describe, it, expect } from 'vitest';
import { createLogger } from '@ekg/shared';
import { handleGitlabPush } from '../../src/server.js';
import { IngestQueue, type IngestJobRequest } from '../../src/queue.js';
import { matchesAllowList, parseAllowList } from '../../src/schema.js';
import { makeRequest, makeResponse, type CapturedResponse } from './helpers.js';

function bodyFor(namespace: string): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    total_commits_count: 1,
    project: { path_with_namespace: namespace, web_url: `https://gl.example.com/${namespace}` },
  });
}

describe('allow-list', () => {
  it('parseAllowList trims and drops empties', () => {
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList('')).toEqual([]);
    expect(parseAllowList(' a , ,b ')).toEqual(['a', 'b']);
  });

  it('matchesAllowList accepts when patterns empty', () => {
    expect(matchesAllowList('any/repo', [])).toBe(true);
  });

  it('matchesAllowList honours globs', () => {
    expect(matchesAllowList('mt/billing', ['mt/*'])).toBe(true);
    expect(matchesAllowList('mt/billing/sub', ['mt/*'])).toBe(false);
    expect(matchesAllowList('mt/billing/sub', ['mt/**'])).toBe(true);
    expect(matchesAllowList('other/repo', ['mt/*'])).toBe(false);
  });

  it('handler rejects with 403 when namespace not allowed', async () => {
    const queue = new IngestQueue({
      maxConcurrent: 5,
      runner: async (_r: IngestJobRequest) => { void _r; },
      logger: createLogger({ service: 'test' }),
    });
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body: bodyFor('outside/repo'),
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), {
      secret: 'sekret', allowList: ['mt/*'], queue,
      logger: createLogger({ service: 'test' }),
    });
    expect(captured.status).toBe(403);
  });

  it('handler accepts with 202 when namespace matches', async () => {
    const queue = new IngestQueue({
      maxConcurrent: 5,
      runner: async (_r: IngestJobRequest) => { void _r; },
      logger: createLogger({ service: 'test' }),
    });
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body: bodyFor('mt/billing'),
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), {
      secret: 'sekret', allowList: ['mt/*'], queue,
      logger: createLogger({ service: 'test' }),
    });
    expect(captured.status).toBe(202);
  });
});
