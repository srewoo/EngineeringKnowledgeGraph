/**
 * Configuration type definitions for ekg.config.json and environment.
 */

export interface RepoConfig {
  readonly url: string;
  readonly branch: string;
  readonly token?: string;
  readonly serviceMappings?: Readonly<Record<string, string>>;
}

export interface EkgConfig {
  readonly repos: readonly RepoConfig[];
  readonly ignoreDirs: readonly string[];
  readonly supportedExtensions: readonly string[];
}

/**
 * Phase 1 of ADR-006 bridge: deployment mode controls which "safe defaults"
 * apply. `local` is the default — single-tenant, no auth, dev credentials OK.
 * `hosted` flips the contract: dev credentials are refused at boot, every
 * request must carry a `tenantId`, audit log is mandatory.
 */
export type DeploymentMode = 'local' | 'hosted';

/**
 * Default tenant identifier used when running in `local` mode and no
 * explicit tenant is supplied by the caller. Choose a non-empty string so
 * Cypher filters never need to handle `null` — the local graph just lives
 * under this tenant.
 */
export const DEFAULT_LOCAL_TENANT_ID = 'local';

/**
 * Known-bad dev credentials we hard-refuse in hosted mode. Adding more is
 * purely additive — the list is never relaxed.
 */
export const FORBIDDEN_DEV_PASSWORDS: ReadonlySet<string> = new Set([
  'ekg-local-dev',
  'password',
  'neo4j',
  'changeme',
  'test',
  'admin',
]);

export interface EnvConfig {
  readonly neo4jUri: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  readonly gitToken?: string;
  readonly logLevel: string;
  readonly dataDir: string;
  /**
   * Phase 1 — deployment mode. Defaults to `local` so existing deployments
   * keep working unchanged. Hosted mode enforces extra invariants at boot
   * (no dev passwords) and at request-time (audit log, tenantId required).
   */
  readonly deploymentMode: DeploymentMode;
  /**
   * Phase 1 — when `local` (default), this is the tenantId stamped onto
   * every node/edge written by this server. Hosted deployments override
   * per-request via the auth proxy.
   */
  readonly tenantId: string;
}
