/**
 * Auth / tenancy interfaces (Phase 2 of ADR-006 bridge, v0).
 *
 * Two seams that production hosted-mode needs:
 *
 *   - `TenantResolver`    — given a raw request token (JWT, API key, ...),
 *                           returns the `RequestContext` to attach.
 *                           Local mode uses `LocalTenantResolver`; OAuth
 *                           termination plugs in as a different impl.
 *
 *   - `TenantSecretStore` — given a `(tenantId, key)`, returns the per-tenant
 *                           secret value (Datadog API key, GitLab token,
 *                           OpenAI key, etc.). Local mode reads from env;
 *                           hosted mode plugs in HashiCorp Vault / AWS
 *                           Secrets Manager / etc.
 *
 * No code here knows about HTTP, OAuth, or Vault — those are concrete
 * implementations that import these interfaces. Keeping the interfaces in
 * `@ekg/shared` means every package can depend on them without dragging
 * in HTTP / Vault clients.
 */

import type { RequestContext } from '../request.context.js';

/**
 * Outcome of resolving an inbound auth token to a `RequestContext`.
 * `denied` reasons are bubbled to the audit log as `status: 'denied'`.
 */
export type TenantResolveResult =
  | { readonly ok: true; readonly context: RequestContext }
  | { readonly ok: false; readonly reason: 'no_token' | 'invalid_token' | 'unknown_tenant' | 'disabled_tenant'; readonly message?: string };

export interface TenantResolver {
  /**
   * Resolve an inbound auth token (raw header value, or `undefined` if no
   * auth was supplied) into a `RequestContext`. Implementations must be
   * deterministic — no I/O failures should bubble; cache misses return
   * `{ ok: false, reason: 'invalid_token' }`.
   */
  resolve(rawToken: string | undefined): Promise<TenantResolveResult>;
}

/**
 * Per-tenant secret store. The contract:
 *   - Returns `undefined` (not throw) when the secret is unset.
 *   - Never logs the value; logs `key` + `tenantId` only.
 *   - Implementations choose their own caching policy.
 */
export interface TenantSecretStore {
  get(tenantId: string, key: string): Promise<string | undefined>;
  /**
   * Optional — only the in-memory impl supports set(). Production stores
   * are written-to via their own admin paths (Vault CLI, AWS console).
   */
  set?(tenantId: string, key: string, value: string): Promise<void>;
}
