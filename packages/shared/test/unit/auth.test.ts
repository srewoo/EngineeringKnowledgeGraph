/**
 * Tests for the Phase 2 auth + per-tenant secret store v0 building blocks.
 * No HTTP / OAuth / Vault involved — just the interfaces and the two
 * in-process implementations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalTenantResolver,
  StaticTokenTenantResolver,
  EnvTenantSecretStore,
  InMemoryTenantSecretStore,
} from '../../src/index.js';

describe('LocalTenantResolver', () => {
  it('resolves any token to the local tenant + system actor', async () => {
    const r = await new LocalTenantResolver().resolve(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.tenantId).toBe('local');
      expect(r.context.actor).toBe('system');
    }
  });

  it('honours a custom default tenantId', async () => {
    const r = await new LocalTenantResolver('demo').resolve('whatever');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.tenantId).toBe('demo');
  });
});

describe('StaticTokenTenantResolver', () => {
  const table = new Map([
    ['tkn-acme',   { tenantId: 'acme', actor: 'alice' }],
    ['tkn-widg',   { tenantId: 'widgetcorp', actor: 'bob' }],
    ['tkn-paused', { tenantId: 'paused', actor: 'svc', enabled: false }],
  ]);

  it('resolves a known token to the configured tenant + actor', async () => {
    const r = await new StaticTokenTenantResolver(table).resolve('tkn-acme');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.tenantId).toBe('acme');
      expect(r.context.actor).toBe('alice');
    }
  });

  it('returns no_token when no token is supplied', async () => {
    const r = await new StaticTokenTenantResolver(table).resolve(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_token');
  });

  it('returns invalid_token for an unknown token', async () => {
    const r = await new StaticTokenTenantResolver(table).resolve('tkn-bogus');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_token');
  });

  it('returns disabled_tenant when the entry has enabled=false', async () => {
    const r = await new StaticTokenTenantResolver(table).resolve('tkn-paused');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disabled_tenant');
  });
});

describe('EnvTenantSecretStore', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      datadog: process.env['EKG_SECRET_ACME_DATADOG_API_KEY'],
      gitlab:  process.env['EKG_SECRET_WIDGETCORP_GITLAB_TOKEN'],
    };
    process.env['EKG_SECRET_ACME_DATADOG_API_KEY'] = 'dd-xyz';
    process.env['EKG_SECRET_WIDGETCORP_GITLAB_TOKEN'] = 'gl-abc';
  });
  afterEach(() => {
    for (const [envKey, original] of Object.entries({
      EKG_SECRET_ACME_DATADOG_API_KEY: saved['datadog'],
      EKG_SECRET_WIDGETCORP_GITLAB_TOKEN: saved['gitlab'],
    })) {
      if (original === undefined) delete process.env[envKey];
      else process.env[envKey] = original;
    }
  });

  it('reads tenant-prefixed env vars', async () => {
    const store = new EnvTenantSecretStore();
    expect(await store.get('acme', 'datadog_api_key')).toBe('dd-xyz');
    expect(await store.get('widgetcorp', 'gitlab_token')).toBe('gl-abc');
  });

  it('returns undefined when the env var is unset or empty', async () => {
    const store = new EnvTenantSecretStore();
    expect(await store.get('does-not-exist', 'whatever')).toBeUndefined();
  });

  it('normalises tenant/key casing + non-word chars to underscores', async () => {
    process.env['EKG_SECRET_ACME_CORP_DATADOG_API_KEY'] = 'norm-ok';
    const store = new EnvTenantSecretStore();
    expect(await store.get('Acme-Corp', 'Datadog API Key')).toBe('norm-ok');
    delete process.env['EKG_SECRET_ACME_CORP_DATADOG_API_KEY'];
  });
});

describe('InMemoryTenantSecretStore', () => {
  it('round-trips a value', async () => {
    const s = new InMemoryTenantSecretStore();
    await s.set!('acme', 'k1', 'v1');
    expect(await s.get('acme', 'k1')).toBe('v1');
  });

  it('isolates by tenant — same key under different tenants returns each value', async () => {
    const s = new InMemoryTenantSecretStore();
    await s.set!('a', 'k', 'va');
    await s.set!('b', 'k', 'vb');
    expect(await s.get('a', 'k')).toBe('va');
    expect(await s.get('b', 'k')).toBe('vb');
  });

  it('returns undefined for missing tenant or key', async () => {
    const s = new InMemoryTenantSecretStore();
    expect(await s.get('absent', 'whatever')).toBeUndefined();
  });
});
