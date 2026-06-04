/**
 * Tests for `withServerAudit` — the proxy that wraps every `.tool(...)`
 * registration with audit + tenant middleware.
 *
 * We avoid the real `McpServer` (it's tied to the SDK) and instead pass a
 * minimal stub that captures the registered handler so we can call it
 * directly and inspect the audit side-effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuditRepository } from '@ekg/storage';
import { withServerAudit } from '../../src/middleware/audit.server.js';

interface RegisteredTool {
  name: string;
  handler: (input: unknown) => Promise<unknown>;
}

function stubServer(registered: RegisteredTool[]): { tool: (...args: unknown[]) => void } {
  return {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: (input: unknown) => Promise<unknown>) => {
      registered.push({ name, handler });
    }),
  };
}

describe('withServerAudit', () => {
  let dir: string;
  let db: Database.Database;
  let audit: AuditRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ekg-as-'));
    db = new Database(join(dir, 'a.db'));
    audit = new AuditRepository(db);
    process.env['EKG_AUDIT_LOCAL'] = 'true';
    process.env['EKG_REQUEST_TENANT_ID'] = 'acme';
    process.env['EKG_REQUEST_ACTOR'] = 'alice';
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['EKG_AUDIT_LOCAL'];
    delete process.env['EKG_REQUEST_TENANT_ID'];
    delete process.env['EKG_REQUEST_ACTOR'];
  });

  it('wraps registered handlers so every invocation records an audit row', async () => {
    const registered: RegisteredTool[] = [];
    const server = stubServer(registered);
    // @ts-expect-error — stub server shape is compatible with the proxy's needs
    withServerAudit(server, { defaultTenantId: 'local', audit, hosted: false });

    // Register two tools as if they were real registrations.
    server.tool('list_things', 'desc', { foo: 'bar' }, async () => ({ content: [{ type: 'text', text: 'one' }] }));
    server.tool('do_thing',    'desc', { x: 1 },      async () => ({ content: [{ type: 'text', text: 'two' }] }));

    expect(registered.length).toBe(2);

    // Invoke each handler — middleware should record one audit row per call.
    await registered[0]!.handler({ foo: 'bar' });
    await registered[1]!.handler({ x: 1 });

    const rows = audit.query({ tenantId: 'acme' });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.tool))).toEqual(new Set(['list_things', 'do_thing']));
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('records `error` status when the wrapped handler returns isError', async () => {
    const registered: RegisteredTool[] = [];
    const server = stubServer(registered);
    // @ts-expect-error stub shape
    withServerAudit(server, { defaultTenantId: 'local', audit, hosted: false });
    server.tool('failing_tool', 'd', {}, async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
    await registered[0]!.handler({});
    const rows = audit.query({ tool: 'failing_tool' });
    expect(rows[0]!.status).toBe('error');
  });

  it('records `error` and re-throws when the handler itself throws', async () => {
    const registered: RegisteredTool[] = [];
    const server = stubServer(registered);
    // @ts-expect-error stub shape
    withServerAudit(server, { defaultTenantId: 'local', audit, hosted: false });
    server.tool('throwing_tool', 'd', {}, async () => { throw new Error('boom'); });
    await expect(registered[0]!.handler({})).rejects.toThrow('boom');
    const rows = audit.query({ tool: 'throwing_tool' });
    expect(rows[0]!.status).toBe('error');
  });
});
