/**
 * DotenvExtractor — pure parser for `.env.example` / `.env.template` /
 * `.env.sample` template files.
 *
 * NEVER parses plain `.env` (could contain real secrets). Emits one
 * `ConfigKey` per `KEY=value` line. Does not emit `SecretRef` — templates
 * have no concrete vendor reference; secret-like keys are flagged via the
 * `isSecret` heuristic only.
 */
import { basename } from 'node:path';
import { type ConfigKeyNode } from '@ekg/shared';
import { isSecretLikeKey, makeConfigKeyNode } from './config.helpers.js';

export interface DotenvExtractionResult {
  readonly configKeys: readonly ConfigKeyNode[];
}

/**
 * Filenames we accept. Plain `.env` is intentionally excluded. The match is
 * deliberate (not a glob) — a typo like `.env-example` would slip through,
 * which is fine: better to err on the side of NOT parsing real secrets.
 */
const TEMPLATE_RE = /^\.env(?:\.[a-z0-9_-]+)?\.(?:example|template|sample|dist)$/i;
const ALT_TEMPLATE_RE = /\.env\.(?:example|template|sample|dist)$/i; // `app.env.template` etc.

const PLACEHOLDER_RE = /^(<.*>|change[_-]?me|xxx+|placeholder|your[_-]?.*here|todo)$/i;

export class DotenvExtractor {
  /** True when the file is a known dotenv *template*. Plain `.env` returns false. */
  static handlesByPath(relativePath: string): boolean {
    const base = basename(relativePath);
    if (TEMPLATE_RE.test(base)) return true;
    if (ALT_TEMPLATE_RE.test(base.toLowerCase())) return true;
    return false;
  }

  /** Lift the `<env>` from `.env.<env>.example`. Returns 'default' otherwise. */
  static envScopeFromFilename(relativePath: string): string {
    const base = basename(relativePath).toLowerCase();
    const m = /^\.env\.([a-z0-9_-]+)\.(?:example|template|sample|dist)$/.exec(base);
    return m?.[1] ?? 'default';
  }

  extract(content: string, relativePath: string, repoUrl: string): DotenvExtractionResult {
    const envScope = DotenvExtractor.envScopeFromFilename(relativePath);
    const lines = content.split(/\r?\n/);
    const out: ConfigKeyNode[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const parsed = parseDotenvLine(raw);
      if (!parsed) continue;
      const { key, value } = parsed;
      const looksPlaceholder = PLACEHOLDER_RE.test(value);
      const isSecret = isSecretLikeKey(key) && (value === '' || looksPlaceholder);
      out.push(makeConfigKeyNode({
        key,
        repoUrl,
        filePath: relativePath,
        sourceLine: i + 1,
        kind: 'ENV',
        defaultValue: value,
        envScope,
        isSecret,
        raw,
      }));
    }

    return { configKeys: out };
  }
}

const KEY_VALUE_RE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;

function parseDotenvLine(raw: string): { key: string; value: string } | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('#')) return undefined;
  const m = KEY_VALUE_RE.exec(raw);
  if (!m) return undefined;
  const key = m[1]!;
  let value = m[2] ?? '';
  // Strip optional matching quotes.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    value = value.slice(1, -1);
  }
  // Strip an inline `#` comment for unquoted values.
  if (!raw.match(/^\s*[A-Z_]+\s*=\s*['"]/) && value.includes(' #')) {
    value = value.slice(0, value.indexOf(' #')).trimEnd();
  }
  return { key, value };
}
