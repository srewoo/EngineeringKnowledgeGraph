/**
 * Production-config guard (Phase 1 of ADR-006 bridge).
 *
 * Runs once at server boot. In `local` mode it's a no-op. In `hosted`
 * mode it refuses any configuration that would have been safe locally
 * but is unsafe in production:
 *
 *   - Dev passwords (`ekg-local-dev`, `password`, `neo4j`, ...).
 *   - `tenantId` left at the local default — hosted servers must override
 *     per-request via an auth proxy, never use a fixed tenant.
 *   - Neo4j URI pointing at `localhost` — hosted deployments use a managed
 *     instance address, never the dev compose default.
 *   - `bolt://` over a public hostname without TLS — only `bolt+s://` /
 *     `neo4j+s://` are allowed off-localhost.
 *
 * The check returns a list of violations rather than throwing — callers
 * decide whether to abort, warn, or write to an audit channel. We surface
 * the rule that fired so operators can fix one violation per redeploy
 * without playing whack-a-mole.
 */

import { FORBIDDEN_DEV_PASSWORDS, DEFAULT_LOCAL_TENANT_ID, type DeploymentMode } from './types/config.types.js';

export interface ProductionGuardInput {
  readonly deploymentMode: DeploymentMode;
  readonly neo4jUri: string;
  readonly neo4jPassword: string;
  readonly tenantId: string;
}

export interface ProductionGuardViolation {
  readonly rule:
    | 'forbidden_password'
    | 'default_tenant_in_hosted'
    | 'localhost_in_hosted'
    | 'insecure_transport';
  readonly message: string;
}

export interface ProductionGuardResult {
  readonly ok: boolean;
  readonly mode: DeploymentMode;
  readonly violations: readonly ProductionGuardViolation[];
}

export function validateProductionConfig(cfg: ProductionGuardInput): ProductionGuardResult {
  if (cfg.deploymentMode === 'local') {
    return { ok: true, mode: 'local', violations: [] };
  }

  const violations: ProductionGuardViolation[] = [];

  if (FORBIDDEN_DEV_PASSWORDS.has(cfg.neo4jPassword.toLowerCase())) {
    violations.push({
      rule: 'forbidden_password',
      message: 'Refusing to start in hosted mode with a known dev password. Set NEO4J_PASSWORD to a strong, unique value.',
    });
  }

  if (cfg.tenantId === DEFAULT_LOCAL_TENANT_ID) {
    violations.push({
      rule: 'default_tenant_in_hosted',
      message: `Refusing to start in hosted mode with tenantId='${DEFAULT_LOCAL_TENANT_ID}'. Hosted deployments must derive tenantId per request via the auth proxy, not from env.`,
    });
  }

  const uri = cfg.neo4jUri.trim().toLowerCase();
  if (uri.includes('localhost') || uri.includes('127.0.0.1') || uri.includes('::1')) {
    violations.push({
      rule: 'localhost_in_hosted',
      message: `NEO4J_URI points at localhost in hosted mode (${cfg.neo4jUri}). Use the managed cluster address.`,
    });
  }

  // bolt:// (insecure) over a non-loopback host means traffic crosses the
  // network unencrypted. Allow it only when explicitly opted-in via
  // EKG_ALLOW_INSECURE_NEO4J=true — useful for VPN-internal hosted deploys
  // where the operator owns the network path.
  const allowInsecure = (process.env['EKG_ALLOW_INSECURE_NEO4J'] ?? '').toLowerCase() === 'true';
  if (!allowInsecure && uri.startsWith('bolt://') && !uri.includes('localhost') && !uri.includes('127.0.0.1')) {
    violations.push({
      rule: 'insecure_transport',
      message: `Refusing bolt:// over a non-localhost host in hosted mode. Use bolt+s:// or neo4j+s:// (or set EKG_ALLOW_INSECURE_NEO4J=true on a trusted internal network).`,
    });
  }

  return { ok: violations.length === 0, mode: 'hosted', violations };
}

/**
 * Convenience: throw a single Error summarising all violations. Callers
 * who want to abort at boot can `validateProductionConfigOrThrow(cfg)`.
 */
export function validateProductionConfigOrThrow(cfg: ProductionGuardInput): void {
  const r = validateProductionConfig(cfg);
  if (r.ok) return;
  const lines = r.violations.map((v) => `  - [${v.rule}] ${v.message}`);
  throw new Error(`Production config check failed (${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
}
