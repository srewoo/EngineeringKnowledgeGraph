import { describe, it, expect } from 'vitest';
import { createLogger } from '@ekg/shared';
import { handleGitlabPush, secretsMatch } from '../../src/server.js';
import { IngestQueue, type IngestJobRequest } from '../../src/queue.js';
import { makeRequest, makeResponse, type CapturedResponse } from './helpers.js';

function makeQueue(): IngestQueue {
  return new IngestQueue({
    maxConcurrent: 5,
    runner: async (_r: IngestJobRequest) => { void _r; },
    logger: createLogger({ service: 'test' }),
  });
}

const VALID_BODY = JSON.stringify({
  ref: 'refs/heads/main',
  before: '11111111111111111111111111111111111111aa',
  after: '22222222222222222222222222222222222222bb',
  total_commits_count: 1,
  project: { path_with_namespace: 'group/repo', web_url: 'https://gitlab.example.com/group/repo' },
});

describe('webhook auth', () => {
  it('rejects missing X-Gitlab-Token header with 401', async () => {
    const captured: CapturedResponse = { headers: {}, body: '' };
    const req = makeRequest({ method: 'POST', url: '/webhook/gitlab/push', body: VALID_BODY });
    const res = makeResponse(captured);
    await handleGitlabPush(req, res, {
      secret: 'sekret', allowList: [], queue: makeQueue(),
      logger: createLogger({ service: 'test' }),
    });
    expect(captured.status).toBe(401);
  });

  it('rejects mismatched secret with 401', async () => {
    const captured: CapturedResponse = { headers: {}, body: '' };
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body: VALID_BODY,
      headers: { 'X-Gitlab-Token': 'wrong' },
    });
    const res = makeResponse(captured);
    await handleGitlabPush(req, res, {
      secret: 'sekret', allowList: [], queue: makeQueue(),
      logger: createLogger({ service: 'test' }),
    });
    expect(captured.status).toBe(401);
  });

  it('accepts a matching secret', async () => {
    const captured: CapturedResponse = { headers: {}, body: '' };
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body: VALID_BODY,
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const res = makeResponse(captured);
    await handleGitlabPush(req, res, {
      secret: 'sekret', allowList: [], queue: makeQueue(),
      logger: createLogger({ service: 'test' }),
    });
    expect(captured.status).toBe(202);
  });

  it('secretsMatch is constant-time and rejects empty configured', () => {
    expect(secretsMatch('a', '')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('abc', 'abc')).toBe(true);
  });
});
