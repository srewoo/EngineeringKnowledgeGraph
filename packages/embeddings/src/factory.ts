/**
 * Embedding provider factory.
 *
 * Reads env config, validates it with Zod, and returns the configured
 * provider. Default: Ollama (local, ₹0). Override via EKG_EMBEDDING_PROVIDER.
 */

import { z } from 'zod';
import type { EmbeddingProvider } from './provider.interface.js';
import { OpenAIEmbeddingProvider } from './openai.provider.js';
import { OllamaEmbeddingProvider } from './ollama.provider.js';
import { VoyageEmbeddingProvider } from './voyage.provider.js';

const envSchema = z.object({
  EKG_EMBEDDING_PROVIDER: z.enum(['openai', 'ollama', 'voyage']).default('ollama'),
  EKG_EMBEDDING_MODEL: z.string().optional(),
  EKG_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
});

export function getEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const parsed = envSchema.parse({
    EKG_EMBEDDING_PROVIDER: env['EKG_EMBEDDING_PROVIDER'],
    EKG_EMBEDDING_MODEL: env['EKG_EMBEDDING_MODEL'],
    EKG_EMBEDDING_DIMENSIONS: env['EKG_EMBEDDING_DIMENSIONS'],
    OPENAI_API_KEY: env['OPENAI_API_KEY'],
    OLLAMA_URL: env['OLLAMA_URL'],
    VOYAGE_API_KEY: env['VOYAGE_API_KEY'],
  });

  switch (parsed.EKG_EMBEDDING_PROVIDER) {
    case 'openai':
      if (!parsed.OPENAI_API_KEY) {
        throw new Error('EKG_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return new OpenAIEmbeddingProvider({
        apiKey: parsed.OPENAI_API_KEY,
        model: parsed.EKG_EMBEDDING_MODEL,
        dimensions: parsed.EKG_EMBEDDING_DIMENSIONS,
      });
    case 'voyage':
      if (!parsed.VOYAGE_API_KEY) {
        throw new Error('EKG_EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY');
      }
      return new VoyageEmbeddingProvider({
        apiKey: parsed.VOYAGE_API_KEY,
        model: parsed.EKG_EMBEDDING_MODEL,
        dimensions: parsed.EKG_EMBEDDING_DIMENSIONS,
      });
    case 'ollama':
    default:
      return new OllamaEmbeddingProvider({
        baseUrl: parsed.OLLAMA_URL,
        model: parsed.EKG_EMBEDDING_MODEL,
        dimensions: parsed.EKG_EMBEDDING_DIMENSIONS,
      });
  }
}
