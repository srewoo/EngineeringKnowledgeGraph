import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteRepository } from '../../src/sqlite.repository.js';
import { AgentSessionRepository } from '../../src/agent-session.repository.js';

describe('AgentSessionRepository', () => {
  let sqlite: SqliteRepository;
  let repo: AgentSessionRepository;

  beforeEach(() => {
    sqlite = new SqliteRepository(':memory:');
    repo = new AgentSessionRepository(sqlite.getConnection());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates and retrieves a session with empty defaults', () => {
    const { sessionId } = repo.create();
    const row = repo.get(sessionId);
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.messages).toBe('[]');
    expect(row?.seenIds).toBe('[]');
    expect(row?.metadata).toBeUndefined();
  });

  it('updates messages, seenIds, metadata and bumps last_used_at', async () => {
    const { sessionId } = repo.create();
    const before = repo.get(sessionId);
    expect(before).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    repo.update(sessionId, {
      messages: JSON.stringify([{ role: 'user', content: 'hi' }]),
      seenIds: JSON.stringify(['a', 'b']),
      metadata: JSON.stringify({ turnCount: 1 }),
    });
    const after = repo.get(sessionId);
    expect(after?.messages).toContain('"role":"user"');
    expect(after?.seenIds).toBe('["a","b"]');
    expect(after?.metadata).toBe('{"turnCount":1}');
    expect(after && after.lastUsedAt > before!.lastUsedAt).toBe(true);
  });

  it('delete returns true on existing, false on missing', () => {
    const { sessionId } = repo.create();
    expect(repo.delete(sessionId)).toBe(true);
    expect(repo.delete(sessionId)).toBe(false);
    expect(repo.get(sessionId)).toBeUndefined();
  });

  it('prune removes only stale rows', () => {
    const fresh = repo.create().sessionId;
    const stale = repo.create().sessionId;
    // Force stale.last_used_at backwards.
    sqlite.getConnection().prepare(
      'UPDATE agent_sessions SET last_used_at = ? WHERE session_id = ?',
    ).run(new Date(Date.now() - 60 * 86_400_000).toISOString(), stale);

    const removed = repo.prune(30);
    expect(removed).toBe(1);
    expect(repo.get(stale)).toBeUndefined();
    expect(repo.get(fresh)).toBeDefined();
  });

  it('prune rejects negative thresholds', () => {
    expect(() => repo.prune(-1)).toThrow();
  });
});
