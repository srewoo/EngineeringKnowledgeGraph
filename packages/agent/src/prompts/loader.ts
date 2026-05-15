/**
 * Prompt loader — pure I/O. Loads `*.system.txt` and `few_shot.json` from
 * disk once at module init. The version line (`# version: vN`) is parsed
 * out of each system prompt for reproducibility.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { QuestionClass } from '@ekg/router';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a prompt asset. Works in three layouts:
 *   1. `tsx`/`ts-node` running source directly: HERE = packages/agent/src/prompts.
 *   2. Compiled JS run from `dist/prompts`: assets live next to the .js (post-build copy).
 *   3. Compiled JS without copy: fall back to `../../src/prompts`.
 */
function resolveAsset(file: string): string {
  const colocated = path.join(HERE, file);
  if (existsSync(colocated)) return colocated;
  const fromDist = path.join(HERE, '..', '..', 'src', 'prompts', file);
  if (existsSync(fromDist)) return fromDist;
  return colocated; // surface the original error
}

export interface LoadedPrompt {
  readonly text: string;
  readonly version: string;
}

const CLASSES: readonly QuestionClass[] = [
  'topology', 'schema', 'code', 'flow', 'ownership',
  'api', 'config', 'ops', 'history', 'unknown',
];

function load(file: string): LoadedPrompt {
  const text = readFileSync(resolveAsset(file), 'utf8');
  const m = text.match(/^#\s*version:\s*(\S+)/m);
  return { text, version: m?.[1] ?? 'unversioned' };
}

const BASE = load('base.system.txt');
const PER_CLASS: ReadonlyMap<QuestionClass, LoadedPrompt> = new Map(
  CLASSES.map((c) => [c, load(`${c}.system.txt`)] as const),
);

interface FewShotExample {
  readonly question: string;
  readonly answer: Record<string, unknown>;
}

const FEW_SHOT: ReadonlyMap<QuestionClass, FewShotExample> = (() => {
  const raw = JSON.parse(readFileSync(resolveAsset('few_shot.json'), 'utf8')) as Record<string, FewShotExample>;
  return new Map(CLASSES.map((c) => [c, raw[c]!]));
})();

export interface BuiltSystemPrompt {
  readonly system: string;
  readonly versions: { readonly base: string; readonly perClass: string };
}

export function buildSystemPrompt(cls: QuestionClass): BuiltSystemPrompt {
  const cls_ = (PER_CLASS.has(cls) ? cls : 'unknown') as QuestionClass;
  const perClass = PER_CLASS.get(cls_)!;
  const example = FEW_SHOT.get(cls_)!;
  const fewShotBlock = [
    '## Example',
    `Q: ${example.question}`,
    `A: ${JSON.stringify(example.answer)}`,
  ].join('\n');
  return {
    system: `${BASE.text}\n\n${perClass.text}\n\n${fewShotBlock}`,
    versions: { base: BASE.version, perClass: perClass.version },
  };
}
