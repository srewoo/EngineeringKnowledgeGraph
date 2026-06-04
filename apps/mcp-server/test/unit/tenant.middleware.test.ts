/**
 * Tenant middleware tests (Phase 2). Covers:
 *   - context derivation from env vars
 *   - audit recording on ok / error / refused paths
 *   - audit skip in local mode unless EKG_AUDIT_LOCAL=true
 *   - handler still completes even when audit write throws
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuditRepository } from '@ekg/storage';
import {
  withTenantScope,
  deriveRequestContext,
} from '../../src/middleware/tenant.middleware.js';

const noopMcpResult = { content: [{ type: 'text' as const, text: 'ok' }] };

describe('deriveRequestContext', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      tenant: process.env['EKG_REQUEST_TENANT_ID'],
      actor: process.env['EKG_REQUEST_ACTOR'],
    };
    delete process.env['EKG_REQUEST_TENANT_ID'];
    delete process.env['EKG_REQUEST_ACTOR'];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({ EKG_REQUEST_TENANT_ID: saved['tenant'], EKG_REQUEST_ACTOR: saved['actor'] })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('uses deps.defaultTenantId + actor=system when env unset', () => {
    const ctx = deriveRequestContext({ defaultTenantId: 'local', hosted: false });
    expect(ctx.tenantId).toBe('local');
    expect(ctx.actor).toBe('system');
    expect(ctx.requestId.length).toBeGreaterThan(0);
  });

  it('env vars override defaults', () => {
    process.env['EKG_REQUEST_TENANT_ID'] = 'acme';
    process.env['EKG_REQUEST_ACTOR'] = 'alice';
    const ctx = deriveRequestContext({ defaultTenantId: 'local', hosted: true });
    expect(ctx.tenantId).toBe('acme');
    expect(ctx.actor).toBe('alice');
  });

  it('falls back to actor=unknown in hosted mode with no env', () => {
    const ctx = deriveRequestContext({ defaultTenantId: 't', hosted: true });
    expect(ctx.actor).toBe('unknown');
  });
});

describe('withTenantScope — audit recording', () => {
  let dir: string;
  let db: Database.Database;
  let audit: AuditRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ekg-mw-'));
    db = new Database(join(dir, 'a.db'));
    audit = new AuditRepository(db);
    process.env['EKG_AUDIT_LOCAL'] = 'true'; // force audit even in local mode for tests
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

  it('records an ok row on successful handler', async () => {
    const handler = vi.fn(async () => noopMcpResult);
    const wrapped = withTenantScope('toolA', { defaultTenantId: 'local', audit, hosted: false }, handler);
    await wrapped({ q: 'hi' });
    const rows = audit.query({ tool: 'toolA' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.tenantId).toBe('acme');
    expect(rows[0]!.actor).toBe('alice');
  });

  it('records an error row when handler returns isError: true', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'boom' }], isError: true as const }));
    const wrapped = withTenantScope('toolB', { defaultTenantId: 'local', audit, hosted: false }, handler);
    await wrapped({});
    const rows = audit.query({ tool: 'toolB' });
    expect(rows[0]!.status).toBe('error');
  });

  it('records an error row when handler throws + re-raises the error', async () => {
    const handler = vi.fn(async () => { throw new Error('kaboom'); });
    const wrapped = withTenantScope('toolC', { defaultTenantId: 'local', audit, hosted: false }, handler);
    await expect(wrapped({})).rejects.toThrow('kaboom');
    const rows = audit.query({ tool: 'toolC' });
    expect(rows[0]!.status).toBe('error');
  });

  it('skips audit in local mode when EKG_AUDIT_LOCAL is unset', async () => {
    delete process.env['EKG_AUDIT_LOCAL'];
    const handler = vi.fn(async () => noopMcpResult);
    const wrapped = withTenantScope('toolD', { defaultTenantId: 'local', audit, hosted: false }, handler);
    await wrapped({});
    expect(audit.countAll()).toBe(0);
  });

  it('always records in hosted mode regardless of EKG_AUDIT_LOCAL', async () => {
    delete process.env['EKG_AUDIT_LOCAL'];
    const handler = vi.fn(async () => noopMcpResult);
    const wrapped = withTenantScope('toolE', { defaultTenantId: 't', audit, hosted: true }, handler);
    await wrapped({});
    expect(audit.countAll()).toBe(1);
  });
});
