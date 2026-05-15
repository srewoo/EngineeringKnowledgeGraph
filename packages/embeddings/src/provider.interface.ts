/**
 * Embedding provider contract.
 *
 * Implementations are pure adapters around HTTP APIs (OpenAI, Voyage) or a
 * local Ollama server. Providers do NOT touch SQLite, the graph, or files —
 * they only convert text → vectors.
 */

export type EmbeddingProviderId = 'openai' | 'ollama' | 'voyage';

export interface EmbeddingProvider {
  readonly id: EmbeddingProviderId;
  readonly model: string;
  readonly dimensions: number;
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}
