/**
 * CiVarsExtractor — pure parser for GitHub Actions and GitLab CI configs.
 *
 * Emits:
 *   - `ConfigKey` for each `variables:` entry and inline `$VAR` reference.
 *   - `SecretRef` (vendor `UNKNOWN`, ref `github:secret/<name>` or
 *     `gitlab:secret/<name>`) for `${{ secrets.X }}` / `$CI_*` patterns
 *     that look like secret bindings.
 */
import { basename } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  createLogger, type ConfigKeyNode, type SecretRefNode, type Logger,
} from '@ekg/shared';
import {
  isSecretLikeKey,
  makeConfigKeyNode,
  makeSecretRefNode,
  stringifyLeaf,
  walkLeaves,
} from './config.helpers.js';

export interface CiVarsExtractionResult {
  readonly configKeys: readonly ConfigKeyNode[];
  readonly secretRefs: readonly SecretRefNode[];
}

type CiKind = 'github' | 'gitlab';

const GH_PATH_RE = /\.github\/workflows\/[^/]+\.ya?ml$/i;
const GL_BASENAMES = new Set(['.gitlab-ci.yml', '.gitlab-ci.yaml']);
const GL_PATH_RE = /\.gitlab\/.+\.ya?ml$/i;

const SECRETS_REF_RE = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;
const VARS_REF_RE = /\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/g;
const SHELL_VAR_RE = /\$([A-Z][A-Z0-9_]{2,})\b/g;

export class CiVarsExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'ci-vars-extractor' });
  }

  static handlesByPath(relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (GH_PATH_RE.test(lower)) return true;
    if (GL_BASENAMES.has(basename(lower))) return true;
    if (GL_PATH_RE.test(lower)) return true;
    return false;
  }

  static detectKind(relativePath: string): CiKind | undefined {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (GH_PATH_RE.test(lower)) return 'github';
    if (GL_BASENAMES.has(basename(lower)) || GL_PATH_RE.test(lower)) return 'gitlab';
    return undefined;
  }

  extract(content: string, relativePath: string, repoUrl: string): CiVarsExtractionResult {
    const kind = CiVarsExtractor.detectKind(relativePath);
    if (!kind) return { configKeys: [], secretRefs: [] };

    let root: unknown;
    try {
      root = yamlLoad(content);
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse CI YAML');
      return { configKeys: [], secretRefs: [] };
    }
    if (!root || typeof root !== 'object') return { configKeys: [], secretRefs: [] };

    const configKeys: ConfigKeyNode[] = [];
    const secretRefs: SecretRefNode[] = [];
    const seenSecrets = new Set<string>();
    const seenConfigs = new Set<string>();

    const recordSecret = (name: string): void => {
      const ref = `${kind}:secret/${name}`;
      if (seenSecrets.has(ref)) return;
      seenSecrets.add(ref);
      secretRefs.push(makeSecretRefNode({
        vendor: 'UNKNOWN',
        ref,
        repoUrl,
        filePath: relativePath,
        sourceLine: 0,
      }));
    };

    const recordConfig = (key: string, defaultValue: string): void => {
      if (seenConfigs.has(key)) return;
      seenConfigs.add(key);
      configKeys.push(makeConfigKeyNode({
        key,
        repoUrl,
        filePath: relativePath,
        sourceLine: 0,
        kind: 'CI',
        defaultValue,
        isSecret: isSecretLikeKey(key),
      }));
    };

    // Strategy 1: walk `variables:` blocks at any depth (HIGH confidence).
    walkVariableBlocks(root, recordConfig);

    // Strategy 2: walk every string leaf for `${{ secrets.X }}` / shell `$VAR`.
    walkLeaves(root, '', 0, (_path, value) => {
      if (typeof value !== 'string') return;
      for (const m of value.matchAll(SECRETS_REF_RE)) {
        const name = m[1];
        if (name) recordSecret(name);
      }
      for (const m of value.matchAll(VARS_REF_RE)) {
        const name = m[1];
        if (name) recordConfig(name, '');
      }
      if (kind === 'gitlab') {
        for (const m of value.matchAll(SHELL_VAR_RE)) {
          const name = m[1];
          if (!name) continue;
          if (name.startsWith('CI_') || isSecretLikeKey(name)) {
            // CI_* are predefined; record as ConfigKey. Secret-named shell
            // vars get logged as ConfigKey too — without a vendor ref we
            // cannot emit a SecretRef.
            recordConfig(name, '');
          }
        }
      }
    });

    return { configKeys, secretRefs };
  }
}

function walkVariableBlocks(
  root: unknown,
  emit: (key: string, defaultValue: string) => void,
): void {
  walkObjectsWithKey(root, 'variables', 0, (vars) => {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return;
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      emit(k, stringifyLeaf(v));
    }
  });
}

const MAX_DEPTH = 12;

function walkObjectsWithKey(
  root: unknown,
  targetKey: string,
  depth: number,
  visit: (value: unknown) => void,
): void {
  if (depth > MAX_DEPTH || root === null || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    for (const item of root) walkObjectsWithKey(item, targetKey, depth + 1, visit);
    return;
  }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (k === targetKey) visit(v);
    walkObjectsWithKey(v, targetKey, depth + 1, visit);
  }
}
