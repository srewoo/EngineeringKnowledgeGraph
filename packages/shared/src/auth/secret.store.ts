/**
 * Two concrete `TenantSecretStore` implementations (Phase 2 v0).
 *
 *   - `EnvTenantSecretStore`        — reads `EKG_SECRET_<TENANT>_<KEY>`
 *                                     from process.env. Useful for
 *                                     single-tenant deployments and
 *                                     CI tests. Never writes.
 *   - `InMemoryTenantSecretStore`   — RAM-only, supports `set()`. Used
 *                                     by tests and any single-process
 *                                     hosted-mode prototype.
 *
 * Production stores (Vault, AWS Secrets Manager, GCP Secret Manager)
 * live in their own packages and are not built in this slice. The
 * interface they implement is the same `TenantSecretStore` — swapping
 * is a configuration choice.
 */

import type { TenantSecretStore } from './auth.interface.js';

/**
 * Read-only secret store backed by process.env.
 *
 * Key format: `EKG_SECRET_<TENANT_UPPER>_<KEY_UPPER>` with non-word
 * characters in tenant/key replaced by underscores.
 *
 * Example: `EKG_SECRET_ACME_DATADOG_API_KEY=xyz` →
 *   store.get('acme', 'datadog_api_key') → 'xyz'.
 */
export class EnvTenantSecretStore implements TenantSecretStore {
  async get(tenantId: string, key: string): Promise<string | undefined> {
    const envKey = `EKG_SECRET_${normalize(tenantId)}_${normalize(key)}`;
    const v = process.env[envKey];
    return v === undefined || v === '' ? undefined : v;
  }
}

/**
 * Mutable in-memory secret store. Suitable for hosted-mode prototypes,
 * eval fixtures, and tests. Not safe for production — values are kept in
 * RAM only.
 */
export class InMemoryTenantSecretStore implements TenantSecretStore {
  private readonly map = new Map<string, string>();

  async get(tenantId: string, key: string): Promise<string | undefined> {
    return this.map.get(`${tenantId}:${key}`);
  }

  async set(tenantId: string, key: string, value: string): Promise<void> {
    this.map.set(`${tenantId}:${key}`, value);
  }

  /** Test helper — never use in production. */
  size(): number { return this.map.size; }
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
