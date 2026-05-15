import { describe, it, expect } from 'vitest';
import { createLogger } from '@ekg/shared';
import { handleGitlabPush } from '../../src/server.js';
import { IngestQueue, type IngestJobRequest } from '../../src/queue.js';
import { makeRequest, makeResponse, type CapturedResponse } from './helpers.js';

function makeDeps(runner?: (r: IngestJobRequest) => Promise<void>) {
  const calls: IngestJobRequest[] = [];
  const queue = new IngestQueue({
    maxConcurrent: 5,
    runner: async (r: IngestJobRequest) => {
      calls.push(r);
      if (runner) await runner(r);
    },
    logger: createLogger({ service: 'test' }),
  });
  return {
    deps: {
      secret: 'sekret', allowList: [], queue,
      logger: createLogger({ service: 'test' }),
    },
    calls,
    queue,
  };
}

describe('webhook payload validation', () => {
  it('enqueues a valid push event and replies 202 with branch/sha', async () => {
    const { deps, calls, queue } = makeDeps();
    const body = JSON.stringify({
      ref: 'refs/heads/feature/foo',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      total_commits_count: 3,
      project: { path_with_namespace: 'g/r', web_url: 'https://gl.example.com/g/r' },
    });
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body,
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), deps);
    expect(captured.status).toBe(202);
    await queue.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.repoUrl).toBe('https://gl.example.com/g/r.git');
    expect(calls[0]?.branch).toBe('feature/foo');
    expect(calls[0]?.commitSha).toBe('b'.repeat(40));
  });

  it('rejects malformed JSON with 400', async () => {
    const { deps } = makeDeps();
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body: '{not-json',
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), deps);
    expect(captured.status).toBe(400);
    expect(captured.body).toContain('malformed_json');
  });

  it('rejects payload that fails schema with 400', async () => {
    const { deps } = makeDeps();
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push',
      body: JSON.stringify({ ref: 'refs/heads/main' }),
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), deps);
    expect(captured.status).toBe(400);
    expect(captured.body).toContain('invalid_payload');
  });

  it('skips branch-creation events (before=zero)', async () => {
    const { deps, calls } = makeDeps();
    const body = JSON.stringify({
      ref: 'refs/heads/new-branch',
      before: '0'.repeat(40),
      after: 'a'.repeat(40),
      total_commits_count: 1,
      project: { path_with_namespace: 'g/r', web_url: 'https://gl.example.com/g/r' },
    });
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body,
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), deps);
    expect(captured.status).toBe(202);
    expect(captured.body).toContain('skipped');
    expect(calls).toHaveLength(0);
  });

  it('skips zero-commit pushes', async () => {
    const { deps, calls } = makeDeps();
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'a'.repeat(40),
      total_commits_count: 0,
      project: { path_with_namespace: 'g/r', web_url: 'https://gl.example.com/g/r' },
    });
    const req = makeRequest({
      method: 'POST', url: '/webhook/gitlab/push', body,
      headers: { 'X-Gitlab-Token': 'sekret' },
    });
    const captured: CapturedResponse = { headers: {}, body: '' };
    await handleGitlabPush(req, makeResponse(captured), deps);
    expect(captured.status).toBe(202);
    expect(calls).toHaveLength(0);
  });
});
