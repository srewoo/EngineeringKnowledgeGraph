/**
 * Prompt loader — pure I/O. Loads `*.system.txt` and `few_shot.json` from
 * disk once at module init. The version line (`# version: vN`) is parsed
 * out of each system prompt for reproducibility.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { QuestionClass } from '@ekg/router';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface LoadedPrompt {
  readonly text: string;
  readonly version: string;
}

const CLASSES: readonly QuestionClass[] = [
  'topology', 'schema', 'code', 'flow', 'ownership',
  'api', 'config', 'ops', 'history', 'unknown',
];

function load(file: string): LoadedPrompt {
  const text = readFileSync(path.join(HERE, file), 'utf8');
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
  const raw = JSON.parse(readFileSync(path.join(HERE, 'few_shot.json'), 'utf8')) as Record<string, FewShotExample>;
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
