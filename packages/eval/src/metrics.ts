/**
 * Citation overlap and faithfulness metrics.
 *
 * Faithfulness here is deliberately heuristic: we never let an LLM grade
 * faithfulness (per llmPLAN §4.1). LLM-as-judge is reserved for fluency
 * (see llm.judge.ts) and is opt-in.
 */

export interface CitationOverlap {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
}

export function citationOverlap(
  predicted: readonly string[],
  gold: readonly string[],
): CitationOverlap {
  const p = new Set(predicted.map((s) => s.trim()).filter((s) => s.length > 0));
  const g = new Set(gold.map((s) => s.trim()).filter((s) => s.length > 0));
  let tp = 0;
  for (const ref of p) if (g.has(ref)) tp += 1;
  const fp = p.size - tp;
  const fn = g.size - tp;
  const precision = p.size === 0 ? (g.size === 0 ? 1 : 0) : tp / p.size;
  const recall = g.size === 0 ? 1 : tp / g.size;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall };
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/g;
const CITATION_MARKER = /\[ref:[^\]]+\]/i;

/**
 * Heuristic faithfulness: fraction of sentences in `answer` that are
 * either (a) marked with an inline `[ref:...]` citation or (b) contain
 * at least one substring from the citation list.
 *
 * Replace with RAGAS / dedicated judge when the eval set graduates.
 */
export function faithfulness(answer: string, citations: readonly string[]): number {
  const text = answer.trim();
  if (text.length === 0) return 0;
  const sentences = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
  if (sentences.length === 0) return 0;
  const refs = citations.map((c) => c.trim()).filter((c) => c.length > 0);
  let supported = 0;
  for (const sent of sentences) {
    if (CITATION_MARKER.test(sent)) {
      supported += 1;
      continue;
    }
    if (refs.some((r) => sent.includes(r))) {
      supported += 1;
    }
  }
  return supported / sentences.length;
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
