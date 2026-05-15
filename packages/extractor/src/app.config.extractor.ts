/**
 * AppConfigExtractor — Spring `application.yaml` / `.properties`,
 * .NET `appsettings.json`, and generic `config.json` parsers.
 *
 * Walks structured config and emits `ConfigKey` (kind `APP`). Spring-style
 * `${ENV_VAR:default}` placeholders ALSO emit a sibling `ConfigKey` for
 * the referenced env var so cross-references resolve at query time.
 */
import { basename } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  createLogger, type ConfigKeyNode, type Logger,
} from '@ekg/shared';
import {
  isSecretLikeKey,
  makeConfigKeyNode,
  stringifyLeaf,
  walkLeaves,
} from './config.helpers.js';

export interface AppConfigExtractionResult {
  readonly configKeys: readonly ConfigKeyNode[];
}

const SPRING_YAML_RE = /^application(?:[-.][a-zA-Z0-9_-]+)?\.ya?ml$/;
const SPRING_PROPS_RE = /^application(?:[-.][a-zA-Z0-9_-]+)?\.properties$/;
const DOTNET_JSON_RE = /^appsettings(?:\.[a-zA-Z0-9_-]+)?\.json$/i;
const GENERIC_JSON_RE = /^(config|app)\.json$/i;

const SPRING_PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g;

type AppFormat = 'yaml' | 'properties' | 'json';

export class AppConfigExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'app-config-extractor' });
  }

  static handlesByPath(relativePath: string): boolean {
    const base = basename(relativePath);
    if (SPRING_YAML_RE.test(base) || SPRING_PROPS_RE.test(base)) return true;
    if (DOTNET_JSON_RE.test(base)) return true;
    if (GENERIC_JSON_RE.test(base)) return true;
    // /config/<anything>.{json,yaml} is a common convention.
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (/\/config\/[^/]+\.(?:json|ya?ml)$/.test(lower)) return true;
    return false;
  }

  static envScopeFromFilename(relativePath: string): string {
    const base = basename(relativePath).toLowerCase();
    const m = /^(?:application|appsettings)[-.]([a-z0-9_-]+)\.(?:ya?ml|properties|json)$/.exec(base);
    return m?.[1] ?? 'default';
  }

  static formatFromFilename(relativePath: string): AppFormat {
    const lower = relativePath.toLowerCase();
    if (lower.endsWith('.properties')) return 'properties';
    if (lower.endsWith('.json')) return 'json';
    return 'yaml';
  }

  extract(content: string, relativePath: string, repoUrl: string): AppConfigExtractionResult {
    const format = AppConfigExtractor.formatFromFilename(relativePath);
    const envScope = AppConfigExtractor.envScopeFromFilename(relativePath);

    const out: ConfigKeyNode[] = [];
    const placeholderEnvVars = new Set<string>();

    if (format === 'properties') {
      this.parseProperties(content, relativePath, repoUrl, envScope, out, placeholderEnvVars);
    } else {
      this.parseStructured(format, content, relativePath, repoUrl, envScope, out, placeholderEnvVars);
    }

    // Cross-reference: emit a sibling ConfigKey for every Spring placeholder
    // env-var name we saw, with `kind: ENV` so it links to the same node a
    // dotenv extractor would emit.
    for (const envVar of placeholderEnvVars) {
      out.push(makeConfigKeyNode({
        key: envVar,
        repoUrl,
        filePath: relativePath,
        sourceLine: 0,
        kind: 'ENV',
        defaultValue: '',
        envScope,
        isSecret: isSecretLikeKey(envVar),
      }));
    }

    return { configKeys: out };
  }

  private parseStructured(
    format: AppFormat,
    content: string,
    relativePath: string,
    repoUrl: string,
    envScope: string,
    out: ConfigKeyNode[],
    placeholders: Set<string>,
  ): void {
    let root: unknown;
    try {
      root = format === 'json' ? JSON.parse(content) : yamlLoad(content);
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse app config');
      return;
    }
    if (!root || typeof root !== 'object') return;

    walkLeaves(root, '', 0, (key, value) => {
      const stringified = stringifyLeaf(value);
      collectPlaceholders(stringified, placeholders);
      out.push(makeConfigKeyNode({
        key,
        repoUrl,
        filePath: relativePath,
        sourceLine: 0,
        kind: 'APP',
        defaultValue: stringified,
        envScope,
        isSecret: isSecretLikeKey(key),
      }));
    });
  }

  private parseProperties(
    content: string,
    relativePath: string,
    repoUrl: string,
    envScope: string,
    out: ConfigKeyNode[],
    placeholders: Set<string>,
  ): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const eq = trimmed.indexOf('=');
      const colon = trimmed.indexOf(':');
      const sep = eq === -1 ? colon : (colon === -1 ? eq : Math.min(eq, colon));
      if (sep <= 0) continue;
      const key = trimmed.slice(0, sep).trim();
      const value = trimmed.slice(sep + 1).trim();
      collectPlaceholders(value, placeholders);
      out.push(makeConfigKeyNode({
        key,
        repoUrl,
        filePath: relativePath,
        sourceLine: i + 1,
        kind: 'APP',
        defaultValue: value,
        envScope,
        isSecret: isSecretLikeKey(key),
      }));
    }
  }
}

function collectPlaceholders(value: string, into: Set<string>): void {
  if (typeof value !== 'string') return;
  for (const m of value.matchAll(SPRING_PLACEHOLDER_RE)) {
    const name = m[1];
    if (name) into.add(name);
  }
}
