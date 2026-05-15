/**
 * Cases loader — reads + validates eval-set JSON.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { EvalCase } from './eval.types.js';

const questionClassSchema = z.enum([
  'topology', 'schema', 'code', 'flow', 'ownership',
  'api', 'config', 'ops', 'history', 'unknown',
]);

const evalCaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expectedClass: questionClassSchema,
  goldCitations: z.array(z.string().min(1)),
  goldAnswer: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const evalCasesSchema = z.array(evalCaseSchema);

export function loadCasesFromFile(path: string): readonly EvalCase[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  return evalCasesSchema.parse(parsed);
}

export function parseCases(raw: unknown): readonly EvalCase[] {
  return evalCasesSchema.parse(raw);
}
