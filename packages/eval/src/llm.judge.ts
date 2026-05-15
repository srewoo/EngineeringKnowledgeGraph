/**
 * LLM-as-judge for *fluency only*. Never used for faithfulness.
 *
 * Opt-in via `EKG_EVAL_JUDGE_ENABLED=true`. Reuses the same LlmProvider
 * the agent uses; capped at 256 output tokens; deterministic temperature.
 *
 * The judge returns a single 0..1 float. Anything outside the range falls
 * back to 0.0 (we do not retry — eval failures should not be silent).
 */

import { createLogger } from '@ekg/shared';
import type { LlmProvider } from '@ekg/agent';

const SYSTEM = [
  'You are a strict grader of *fluency* (not factual correctness).',
  'Score the answer on a single dimension: how clearly written, well-structured,',
  'and grammatical the answer is. Ignore whether claims are true or supported.',
  'Reply with ONLY a single decimal number between 0.0 and 1.0. No prose.',
].join(' ');

export interface JudgeOptions {
  readonly enabled: boolean;
}

export function readJudgeEnv(env: NodeJS.ProcessEnv = process.env): JudgeOptions {
  return { enabled: env['EKG_EVAL_JUDGE_ENABLED'] === 'true' };
}

export function makeFluencyJudge(
  provider: LlmProvider,
  opts: JudgeOptions,
): (question: string, answer: string) => Promise<number> {
  const logger = createLogger({ service: 'eval-judge' });
  return async (question: string, answer: string): Promise<number> => {
    if (!opts.enabled) return 0;
    try {
      const completion = await provider.complete({
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Question:\n${question}\n\nAnswer:\n${answer}\n\nFluency score (0.0-1.0):`,
        }],
        tools: [],
        maxTokens: 256,
        temperature: 0,
      });
      const parsed = parseScore(completion.content);
      if (parsed === undefined) {
        logger.warn({ raw: completion.content.slice(0, 80) }, 'judge: unparseable score');
        return 0;
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'judge: provider error');
      return 0;
    }
  };
}

function parseScore(raw: string): number | undefined {
  const m = raw.trim().match(/-?\d*\.?\d+/);
  if (!m) return undefined;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 1) return undefined;
  return n;
}
