/**
 * `LocalTenantResolver` — the default resolver for local-mode deployments.
 *
 * Every request resolves to the single configured tenant (defaults to
 * `'local'`); the inbound token is ignored. This is the minimum that
 * lets the rest of the system depend on `TenantResolver` without forcing
 * local users to set up an auth proxy.
 *
 * Tests run with `actor: 'system'` for local; hosted-mode tests use the
 * `StaticTokenTenantResolver` below.
 */

import { makeRequestContext } from '../request.context.js';
import type { TenantResolveResult, TenantResolver } from './auth.interface.js';

export class LocalTenantResolver implements TenantResolver {
  constructor(private readonly tenantId: string = 'local') {}

  async resolve(_token: string | undefined): Promise<TenantResolveResult> {
    return {
      ok: true,
      context: makeRequestContext({ tenantId: this.tenantId, actor: 'system' }),
    };
  }
}

/**
 * A trivial resolver for tests / local hosted-mode smoke tests:
 * maps a configured table of `token → (tenantId, actor)`.
 *
 * The intended *production* resolver is OAuth/JWT-based and lives in a
 * separate package (`@ekg/auth-oauth`, not built yet). This impl exists
 * so hosted mode is testable end-to-end without an external IdP.
 */
export class StaticTokenTenantResolver implements TenantResolver {
  constructor(
    private readonly table: ReadonlyMap<string, { tenantId: string; actor: string; enabled?: boolean }>,
  ) {}

  async resolve(token: string | undefined): Promise<TenantResolveResult> {
    if (!token) return { ok: false, reason: 'no_token' };
    const entry = this.table.get(token);
    if (!entry) return { ok: false, reason: 'invalid_token' };
    if (entry.enabled === false) return { ok: false, reason: 'disabled_tenant' };
    return {
      ok: true,
      context: makeRequestContext({ tenantId: entry.tenantId, actor: entry.actor }),
    };
  }
}
