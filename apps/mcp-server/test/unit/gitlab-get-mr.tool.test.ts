import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGitlabGetMrTool } from '../../src/tools/gitlab-get-mr.tool.js';

const ORIGINAL_FETCH = globalThis.fetch;

function setFetch(handler: (url: string) => Response | Promise<Response>): void {
  // @ts-expect-error — override global fetch
  globalThis.fetch = vi.fn(async (url: string | URL) => handler(String(url)));
}

beforeEach(() => {
  setFetch(() => new Response('not used', { status: 200 }));
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function getHandler(token = 't') {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerGitlabGetMrTool(server, { gitlabUrl: 'https://gitlab.example.com', token });
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })._registeredTools['gitlab_get_mr'];
  if (!reg) throw new Error('gitlab_get_mr not registered');
  return reg.handler;
}

describe('gitlab_get_mr', () => {
  it('errors when token is empty', async () => {
    const handler = getHandler('');
    const res = (await handler({ url: 'https://gitlab.com/g/p/-/merge_requests/1', maxDiscussions: 5 })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it('errors when URL is unparseable', async () => {
    const handler = getHandler();
    const res = (await handler({ url: 'https://example.com/no-mr', maxDiscussions: 5 })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it('aggregates MR + changes + pipelines + approvals into a structured summary', async () => {
    setFetch((url) => {
      if (url.endsWith('/merge_requests/42')) {
        return new Response(JSON.stringify({
          id: 1, iid: 42, state: 'opened', title: 'Add Helm value for X',
          description: 'BREAKING CHANGE: removes the old API.',
          source_branch: 'feat/x', target_branch: 'main',
          author: { username: 'sharaj' }, draft: false, has_conflicts: false,
          detailed_merge_status: 'mergeable', user_notes_count: 1,
          labels: ['infra'], web_url: 'https://gitlab.example.com/g/p/-/merge_requests/42',
          diff_refs: { head_sha: 'abc' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/changes')) {
        return new Response(JSON.stringify({
          changes: [
            { old_path: 'helm/values.yaml', new_path: 'helm/values.yaml', diff: '+a\n+b\n-c\n' },
            { old_path: 'src/foo.go', new_path: 'src/foo.go', diff: '+1\n+2\n+3\n' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/discussions')) {
        return new Response(JSON.stringify([
          { id: 'd1', notes: [{ id: 1, body: 'Looks good but check rollout', author: { username: 'reviewer' }, created_at: '2026-05-17T10:00:00Z', resolvable: true, resolved: false }] },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/pipelines')) {
        return new Response(JSON.stringify([
          { id: 100, status: 'failed', ref: 'feat/x', sha: 'abc', web_url: 'https://gitlab.example.com/p/100' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/approvals')) {
        return new Response(JSON.stringify({ approvals_required: 2, approvals_left: 2, approved_by: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });

    const handler = getHandler();
    const res = (await handler({ url: 'https://gitlab.example.com/g/p/-/merge_requests/42', maxDiscussions: 5 })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0]!.text);
    expect(out.mr.iid).toBe(42);
    expect(out.diff.filesChanged).toBe(2);
    expect(out.diff.byTag.helm).toBe(1);
    expect(out.pipelines).toHaveLength(1);
    expect(out.approvals.left).toBe(2);
    const risksJoined = out.risks.join('|');
    expect(risksJoined).toContain('helm');
    expect(risksJoined.toLowerCase()).toContain('breaking change');
    expect(risksJoined).toContain('failed');
  });
});
