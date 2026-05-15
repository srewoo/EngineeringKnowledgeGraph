/**
 * Vault-path parser (Phase 1.6 follow-ups).
 *
 * Pure regex parser: given a raw secret reference string and the secret
 * vendor it was classified as, return the logical mount path that
 * deduplicates many keys under one Vault namespace node.
 *
 * Examples:
 *   - `vault:secret/data/users#api_key`
 *     → mountPath=`secret/data/users`, key=`api_key`
 *   - `arn:aws:secretsmanager:us-east-1:123:secret:db-creds-AbCd:password`
 *     → mountPath=`arn:aws:secretsmanager:us-east-1:123:secret:db-creds-AbCd`
 *   - `projects/my-proj/secrets/api-key/versions/3`
 *     → mountPath=`projects/my-proj/secrets/api-key`
 *   - `https://my-vault.vault.azure.net/secrets/db-pwd/abc123`
 *     → mountPath=`my-vault.vault.azure.net/secrets/db-pwd`
 *   - `kube-system/dockercfg#password` (vendor=K8S_SECRET)
 *     → mountPath=`k8s/kube-system/dockercfg`
 *
 * Returns `undefined` mountPath when the reference doesn't fit any known
 * shape — caller skips Vault-node emission in that case.
 */

import type { SecretVendor } from '@ekg/shared';

export interface ParsedVaultPath {
  readonly vendor: SecretVendor;
  readonly mountPath?: string;
  readonly key?: string;
}

export class VaultPathParser {
  /**
   * Parse a SecretRef.ref into its logical namespace + key.
   * Pure: no I/O, no allocations beyond the result.
   */
  parse(ref: string, vendor: SecretVendor): ParsedVaultPath {
    if (!ref) return { vendor };
    const trimmed = ref.trim();

    switch (vendor) {
      case 'VAULT': return parseVault(trimmed);
      case 'AWS_SM': return parseAwsSm(trimmed);
      case 'AWS_PARAMS': return parseAwsParams(trimmed);
      case 'GCP_SECRETS': return parseGcp(trimmed);
      case 'AZURE_KV': return parseAzure(trimmed);
      case 'K8S_SECRET': return parseK8s(trimmed);
      case 'UNKNOWN': return { vendor };
    }
  }
}

// -- Per-vendor parsers ------------------------------------------------------

/** `vault:<engine>/<...>#<key>` — covers KV v1 (`kv/<mount>`) and KV v2 (`secret/data/<a>/<b>`). */
const VAULT_RE = /^vault:([^#]+?)(?:#(.+))?$/i;

function parseVault(ref: string): ParsedVaultPath {
  const m = VAULT_RE.exec(ref);
  if (!m) return { vendor: 'VAULT' };
  const path = (m[1] ?? '').replace(/\/+$/, '');
  const key = m[2];
  if (!path) return { vendor: 'VAULT' };
  return key
    ? { vendor: 'VAULT', mountPath: path, key }
    : { vendor: 'VAULT', mountPath: path };
}

/**
 * AWS Secrets Manager ARN — secret ARNs have the form
 * `arn:aws:secretsmanager:<region>:<acct>:secret:<name>` and may carry a
 * `:<jsonKey>` suffix for retrieving a single field.
 */
const AWS_SM_RE = /^(arn:aws:secretsmanager:[^:]*:[^:]*:secret:[^:]+?)(?::([^:]+))?$/i;

function parseAwsSm(ref: string): ParsedVaultPath {
  const m = AWS_SM_RE.exec(ref);
  if (!m) return { vendor: 'AWS_SM' };
  const mountPath = m[1];
  const key = m[2];
  if (!mountPath) return { vendor: 'AWS_SM' };
  return key
    ? { vendor: 'AWS_SM', mountPath, key }
    : { vendor: 'AWS_SM', mountPath };
}

/** SSM parameter ARN: `arn:aws:ssm:<region>:<acct>:parameter/<name>`. */
const AWS_PARAMS_RE = /^(arn:aws:ssm:[^:]*:[^:]*:parameter\/[\w./_-]+)$/i;

function parseAwsParams(ref: string): ParsedVaultPath {
  const m = AWS_PARAMS_RE.exec(ref);
  if (!m?.[1]) return { vendor: 'AWS_PARAMS' };
  return { vendor: 'AWS_PARAMS', mountPath: m[1] };
}

/** GCP: `projects/<id>/secrets/<name>/versions/<v>`. */
const GCP_RE = /^(projects\/[^/]+\/secrets\/[^/]+)(?:\/versions\/[^/]+)?$/i;

function parseGcp(ref: string): ParsedVaultPath {
  const m = GCP_RE.exec(ref);
  if (!m?.[1]) return { vendor: 'GCP_SECRETS' };
  return { vendor: 'GCP_SECRETS', mountPath: m[1], key: 'value' };
}

/** Azure KV: `https://<vault>.vault.azure.net/secrets/<name>/<version>`. */
const AZURE_RE = /^https?:\/\/([a-z0-9-]+\.vault\.azure\.net\/secrets\/[^/]+)(?:\/[^/]+)?$/i;

function parseAzure(ref: string): ParsedVaultPath {
  const m = AZURE_RE.exec(ref);
  if (!m?.[1]) return { vendor: 'AZURE_KV' };
  return { vendor: 'AZURE_KV', mountPath: m[1] };
}

/**
 * K8s Secret references — accepted shapes (matching `K8sManifestExtractor`):
 *   - `<namespace>/<secret-name>#<key>`
 *   - `<secret-name>#<key>`        (default namespace implied)
 *   - `k8s:<namespace>/<secret-name>#<key>`
 */
const K8S_RE = /^(?:k8s:)?(?:([\w-]+)\/)?([\w.-]+)(?:#(.+))?$/;

function parseK8s(ref: string): ParsedVaultPath {
  const m = K8S_RE.exec(ref);
  if (!m) return { vendor: 'K8S_SECRET' };
  const namespace = m[1] ?? 'default';
  const name = m[2];
  const key = m[3];
  if (!name) return { vendor: 'K8S_SECRET' };
  const mountPath = `k8s/${namespace}/${name}`;
  return key
    ? { vendor: 'K8S_SECRET', mountPath, key }
    : { vendor: 'K8S_SECRET', mountPath };
}

// -- Helpers exposed for the pipeline ---------------------------------------

/** Build the deterministic Vault-node id used for dedup in Neo4j. */
export function vaultNodeId(vendor: SecretVendor, mountPath: string): string {
  return `vault:${vendor}:${mountPath}`;
}
