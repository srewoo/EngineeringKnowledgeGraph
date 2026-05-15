/**
 * HelmValuesExtractor — pure deterministic parser for Helm `values.yaml`
 * (and per-environment overrides like `values.prod.yaml`).
 *
 * Walks the YAML and emits one `ConfigKey` per leaf, flagging string values
 * that look like external-secret placeholders as `SecretRef` instead.
 *
 * Confidence is HIGH — values come from structured YAML, not heuristics.
 */
import { basename } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { createLogger, type ConfigKeyNode, type SecretRefNode, type Logger } from '@ekg/shared';
import {
  classifySecretVendor,
  isSecretLikeKey,
  looksLikeSecretReference,
  makeConfigKeyNode,
  makeSecretRefNode,
  stringifyLeaf,
  walkLeaves,
} from './config.helpers.js';

export interface HelmExtractionResult {
  readonly configKeys: readonly ConfigKeyNode[];
  readonly secretRefs: readonly SecretRefNode[];
}

const HELM_PATH_HINTS = ['/charts/', '/helm/'];
const HELM_FILE_RE = /^values(?:\.[a-zA-Z0-9_-]+)?\.ya?ml$/;

export class HelmValuesExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'helm-values-extractor' });
  }

  /**
   * Detect by basename `values.yaml` / `values.<env>.yaml` *or* any YAML file
   * under a `/charts/` or `/helm/` path segment.
   */
  static handlesByPath(relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (HELM_FILE_RE.test(basename(lower))) return true;
    if (!/\.ya?ml$/.test(lower)) return false;
    // Match `/charts/` / `/helm/` as a path segment, with or without a
    // leading slash on the relative path.
    const padded = `/${lower}`;
    return HELM_PATH_HINTS.some((hint) => padded.includes(hint));
  }

  /** Lift the `<env>` from `values.<env>.yaml`. Default returns 'default'. */
  static envScopeFromFilename(relativePath: string): string {
    const base = basename(relativePath).toLowerCase();
    const m = /^values\.([a-zA-Z0-9_-]+)\.ya?ml$/.exec(base);
    return m?.[1] ?? 'default';
  }

  extract(content: string, relativePath: string, repoUrl: string): HelmExtractionResult {
    let root: unknown;
    try {
      root = yamlLoad(content);
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse Helm values YAML');
      return { configKeys: [], secretRefs: [] };
    }
    if (!root || typeof root !== 'object') {
      return { configKeys: [], secretRefs: [] };
    }

    const envScope = HelmValuesExtractor.envScopeFromFilename(relativePath);
    const configKeys: ConfigKeyNode[] = [];
    const secretRefs: SecretRefNode[] = [];

    walkLeaves(root, '', 0, (key, value) => {
      // Sniff for vendor-style secret references first — they take precedence.
      if (typeof value === 'string' && looksLikeSecretReference(value)) {
        secretRefs.push(makeSecretRefNode({
          vendor: classifySecretVendor(value),
          ref: value.trim(),
          repoUrl,
          filePath: relativePath,
          sourceLine: 0,
        }));
        return;
      }
      const defaultValue = stringifyLeaf(value);
      configKeys.push(makeConfigKeyNode({
        key,
        repoUrl,
        filePath: relativePath,
        sourceLine: 0,
        kind: 'HELM',
        defaultValue,
        envScope,
        isSecret: isSecretLikeKey(key),
      }));
    });

    return { configKeys, secretRefs };
  }
}
