/**
 * Shared prompt + response schema for LLM routers.
 * Kept separate so all providers emit the same JSON contract.
 */

import { z } from 'zod';

export const ROUTER_SYSTEM_PROMPT = [
  'You are a question classifier for a code knowledge graph.',
  'Classify the user question into exactly one of these classes:',
  'topology, schema, code, flow, ownership, api, config, ops, history, unknown.',
  '',
  'Respond ONLY as compact JSON with this exact shape:',
  '{"class":"<one>","confidence":<0..1 number>,"reasoning":"<short string>"}',
  'No markdown, no commentary outside the JSON.',
].join('\n');

export const QUESTION_CLASS_VALUES = [
  'topology', 'schema', 'code', 'flow', 'ownership',
  'api', 'config', 'ops', 'history', 'unknown',
] as const;

export const llmClassificationSchema = z.object({
  class: z.enum(QUESTION_CLASS_VALUES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(500),
});

export const COMPLETION_TOKEN_CAP = 200;

/**
 * Some models wrap JSON in code fences or extra text. Extract the first
 * JSON object substring and parse it. Throws on failure.
 */
export function parseLlmJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('LLM response contains no JSON object');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}
