/**
 * Reranker factory — env-driven selection.
 *
 *   EKG_RERANKER=noop|cohere|voyage   (default: noop)
 *   COHERE_API_KEY=...                (required for cohere)
 *   VOYAGE_API_KEY=...                (required for voyage)
 *   EKG_RERANKER_MODEL=...            (override default model)
 */

import { z } from 'zod';
import { CohereReranker } from './cohere.reranker.js';
import { VoyageReranker } from './voyage.reranker.js';
import { NoopReranker } from './noop.reranker.js';
import type { Reranker } from './reranker.interface.js';

const envSchema = z.object({
  EKG_RERANKER: z.enum(['noop', 'cohere', 'voyage']).default('noop'),
  EKG_RERANKER_MODEL: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
});

export function getReranker(env: NodeJS.ProcessEnv = process.env): Reranker {
  const parsed = envSchema.parse({
    EKG_RERANKER: env['EKG_RERANKER'],
    EKG_RERANKER_MODEL: env['EKG_RERANKER_MODEL'],
    COHERE_API_KEY: env['COHERE_API_KEY'],
    VOYAGE_API_KEY: env['VOYAGE_API_KEY'],
  });

  switch (parsed.EKG_RERANKER) {
    case 'cohere': {
      if (!parsed.COHERE_API_KEY) throw new Error('EKG_RERANKER=cohere requires COHERE_API_KEY');
      return new CohereReranker({
        apiKey: parsed.COHERE_API_KEY,
        ...(parsed.EKG_RERANKER_MODEL ? { model: parsed.EKG_RERANKER_MODEL } : {}),
      });
    }
    case 'voyage': {
      if (!parsed.VOYAGE_API_KEY) throw new Error('EKG_RERANKER=voyage requires VOYAGE_API_KEY');
      return new VoyageReranker({
        apiKey: parsed.VOYAGE_API_KEY,
        ...(parsed.EKG_RERANKER_MODEL ? { model: parsed.EKG_RERANKER_MODEL } : {}),
      });
    }
    case 'noop':
    default:
      return new NoopReranker();
  }
}
