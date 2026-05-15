import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FeedbackRepository } from '../../src/feedback.repository.js';

describe('FeedbackRepository', () => {
  let db: Database.Database;
  let repo: FeedbackRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new FeedbackRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts an up vote and lists it back', () => {
    const row = repo.upsert({ traceId: 't1', question: 'q?', verdict: 'up' });
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    const list = repo.listByVerdict('up');
    expect(list).toHaveLength(1);
    expect(list[0]?.traceId).toBe('t1');
  });

  it('lists down votes separately from up votes', () => {
    repo.upsert({ traceId: 'a', question: 'q', verdict: 'up' });
    repo.upsert({ traceId: 'b', question: 'q', verdict: 'down', reason: 'wrong' });
    expect(repo.listByVerdict('up')).toHaveLength(1);
    const downs = repo.listByVerdict('down');
    expect(downs).toHaveLength(1);
    expect(downs[0]?.reason).toBe('wrong');
  });

  it('counts by verdict', () => {
    repo.upsert({ traceId: '1', question: 'q', verdict: 'up' });
    repo.upsert({ traceId: '2', question: 'q', verdict: 'up' });
    repo.upsert({ traceId: '3', question: 'q', verdict: 'down' });
    const counts = repo.countByVerdict();
    expect(counts.up).toBe(2);
    expect(counts.down).toBe(1);
  });

  it('rejects invalid verdicts via CHECK constraint', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO answer_feedback (id, trace_id, question, verdict, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('x', 't', 'q', 'maybe', null, new Date().toISOString());
    }).toThrow();
  });

  it('listByTrace returns all feedback for a trace', () => {
    repo.upsert({ traceId: 't1', question: 'q', verdict: 'up' });
    repo.upsert({ traceId: 't1', question: 'q', verdict: 'down', reason: 'changed mind' });
    expect(repo.listByTrace('t1')).toHaveLength(2);
  });

  it('listByVerdict caps to 1000', () => {
    for (let i = 0; i < 5; i += 1) {
      repo.upsert({ traceId: `t${i}`, question: 'q', verdict: 'up' });
    }
    expect(repo.listByVerdict('up', 99999)).toHaveLength(5);
  });
});
