/**
 * Shared helpers for the Phase 1.6 config & secrets extractors.
 *
 * Pure, deterministic, no I/O. All node-id generation and secret-vendor
 * classification lives here so individual extractors stay small.
 */
import type {
  ConfigKeyNode, SecretRefNode, ConfigKind, SecretVendor,
} from '@ekg/shared';

/** Hard cap on the `raw` provenance string saved on a ConfigKey node. */
export const MAX_RAW_BYTES = 256;

/** Hard cap on YAML walker depth — guards against pathological refs. */
export const MAX_WALK_DEPTH = 12;

/**
 * Names that, when present in an env-style key, suggest the value is a
 * secret. Heuristic only — never marks a node `isSecret: true` based on
 * the *value*, only the *key name*.
 */
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|BEARER|ACCESS[_-]?KEY)/i;

export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Build a deterministic, repo-scoped ConfigKey id. Includes file path so
 * the same key in two different files stays distinct.
 */
export function configKeyId(repoUrl: string, filePath: string, key: string, envScope?: string): string {
  const scope = envScope && envScope.length > 0 ? `@${envScope}` : '';
  return `cfg:${repoUrl}:${filePath}:${key}${scope}`;
}

export function secretRefId(repoUrl: string, filePath: string, ref: string): string {
  return `secret:${repoUrl}:${filePath}:${ref}`;
}

export function makeConfigKeyNode(opts: {
  key: string;
  repoUrl: string;
  filePath: string;
  sourceLine: number;
  kind: ConfigKind;
  defaultValue?: string;
  envScope?: string;
  isSecret: boolean;
  raw?: string;
}): ConfigKeyNode {
  const props: Record<string, unknown> = {
    key: opts.key,
    repoUrl: opts.repoUrl,
    filePath: opts.filePath,
    sourceLine: opts.sourceLine,
    kind: opts.kind,
    isSecret: opts.isSecret,
  };
  if (opts.defaultValue !== undefined) props['defaultValue'] = opts.defaultValue;
  if (opts.envScope) props['envScope'] = opts.envScope;
  if (opts.raw) props['raw'] = opts.raw.slice(0, MAX_RAW_BYTES);
  return {
    id: configKeyId(opts.repoUrl, opts.filePath, opts.key, opts.envScope),
    label: 'ConfigKey',
    name: opts.key,
    properties: props as ConfigKeyNode['properties'],
  };
}

export function makeSecretRefNode(opts: {
  vendor: SecretVendor;
  ref: string;
  repoUrl: string;
  filePath: string;
  sourceLine: number;
}): SecretRefNode {
  return {
    id: secretRefId(opts.repoUrl, opts.filePath, opts.ref),
    label: 'SecretRef',
    name: opts.ref,
    properties: {
      vendor: opts.vendor,
      ref: opts.ref,
      repoUrl: opts.repoUrl,
      filePath: opts.filePath,
      sourceLine: opts.sourceLine,
    },
  };
}

// -- Vendor classification ---------------------------------------------------

const VAULT_RE = /^(?:vault:|secret\/data\/)/i;
const AWS_SM_ARN_RE = /^arn:aws:secretsmanager:/i;
const AWS_PARAMS_ARN_RE = /^arn:aws:ssm:.*:parameter\//i;
const GCP_SECRETS_RE = /^projects\/[^/]+\/secrets\//i;
const AZURE_KV_RE = /^https?:\/\/[a-z0-9-]+\.vault\.azure\.net\//i;

/**
 * Classify a secret reference string by inspecting its prefix / shape.
 * Conservative — falls back to `UNKNOWN` rather than guessing.
 */
export function classifySecretVendor(ref: string): SecretVendor {
  const trimmed = ref.trim();
  if (VAULT_RE.test(trimmed)) return 'VAULT';
  if (AWS_SM_ARN_RE.test(trimmed)) return 'AWS_SM';
  if (AWS_PARAMS_ARN_RE.test(trimmed)) return 'AWS_PARAMS';
  if (GCP_SECRETS_RE.test(trimmed)) return 'GCP_SECRETS';
  if (AZURE_KV_RE.test(trimmed)) return 'AZURE_KV';
  return 'UNKNOWN';
}

/**
 * Returns true when a YAML/Helm string value is a placeholder pointing at
 * an external secret store rather than a literal default.
 */
export function looksLikeSecretReference(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (VAULT_RE.test(value)) return true;
  if (AWS_SM_ARN_RE.test(value)) return true;
  if (AWS_PARAMS_ARN_RE.test(value)) return true;
  if (GCP_SECRETS_RE.test(value)) return true;
  if (AZURE_KV_RE.test(value)) return true;
  // Helm-style `${secrets.foo}` / `{{ .Values.secret.foo }}` placeholders.
  if (/\$\{?\s*secrets?\./i.test(value)) return true;
  return false;
}

/**
 * Stringify a YAML leaf value for storage as `defaultValue`. Booleans /
 * numbers stringified verbatim; objects/arrays JSON-encoded with a hard
 * cap so giant structures cannot bloat the graph.
 */
export function stringifyLeaf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, MAX_RAW_BYTES);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, MAX_RAW_BYTES);
  } catch {
    return '';
  }
}

/** True for primitive YAML leaves we want to emit as ConfigKey values. */
export function isLeaf(value: unknown): boolean {
  return value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

/**
 * Walk an object and yield dot-path / leaf pairs. Caps depth at MAX_WALK_DEPTH.
 * Arrays are flattened with `[i]` segments.
 */
export function walkLeaves(
  root: unknown,
  prefix: string,
  depth: number,
  visit: (path: string, value: unknown) => void,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (isLeaf(root)) {
    if (prefix) visit(prefix, root);
    return;
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      walkLeaves(root[i], `${prefix}[${i}]`, depth + 1, visit);
    }
    return;
  }
  if (typeof root === 'object' && root !== null) {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      walkLeaves(v, next, depth + 1, visit);
    }
  }
}
