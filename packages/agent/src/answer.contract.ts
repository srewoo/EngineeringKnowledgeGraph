/**
 * Answer contract — every agent answer must conform to this schema and pass
 * extra invariants:
 *   - At least one citation.
 *   - Citations must reference IDs/paths that the agent actually retrieved
 *     during the loop (no hallucinated refs).
 */

import { z } from 'zod';
import type { SeenIds } from './tools/tool.interface.js';

export const citationKindSchema = z.enum(['code', 'doc', 'table', 'api', 'graph']);
export const confidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export const citationSchema = z.object({
  kind: citationKindSchema,
  ref: z.string().min(1),
  excerpt: z.string().optional(),
});

export const relatedNodeSchema = z.object({
  label: z.string().min(1),
  id: z.string().min(1),
  reason: z.string().min(1),
});

export const answerSchema = z.object({
  answer: z.string().min(1),
  confidence: confidenceSchema,
  citations: z.array(citationSchema).min(1),
  relatedNodes: z.array(relatedNodeSchema).optional(),
});

export type Citation = z.infer<typeof citationSchema>;
export type Answer = z.infer<typeof answerSchema>;

export interface ValidationOk {
  readonly ok: true;
  readonly answer: Answer;
}

export interface ValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type ValidationResult = ValidationOk | ValidationErr;

export interface ValidateOptions {
  readonly seen: SeenIds;
  /** If true, the loop never produced any retrieval — refuse outright. */
  readonly retrievalEmpty: boolean;
}

export function validateAnswer(raw: unknown, opts: ValidateOptions): ValidationResult {
  if (opts.retrievalEmpty) {
    return { ok: false, error: 'REFUSE: no grounded retrieval' };
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    return { ok: false, error: `schema invalid: ${msg}` };
  }
  const ans = parsed.data;
  if (ans.citations.length === 0) {
    return { ok: false, error: 'at least one citation is required' };
  }
  const unseen = ans.citations.filter((c) => !citationReferencesSeen(c, opts.seen));
  if (unseen.length > 0) {
    const refs = unseen.map((c) => c.ref).slice(0, 5).join(', ');
    return {
      ok: false,
      error: `citation(s) not produced by any tool call: ${refs}`,
    };
  }
  return { ok: true, answer: ans };
}

function citationReferencesSeen(c: Citation, seen: SeenIds): boolean {
  if (seen.has(c.ref)) return true;
  // Allow loose matches: any seen ID is a substring of the citation ref, or
  // vice versa. This handles cases like "repo:path:start-end" where the seen
  // ID was "repo:path".
  for (const id of seen.values()) {
    if (!id) continue;
    if (c.ref === id) return true;
    if (c.ref.includes(id) || id.includes(c.ref)) return true;
  }
  return false;
}

/**
 * Try to extract a JSON object from raw assistant text. Tolerates code fences.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return safeParse(trimmed);
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) return safeParse(fenceMatch[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return safeParse(trimmed.slice(start, end + 1));
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
