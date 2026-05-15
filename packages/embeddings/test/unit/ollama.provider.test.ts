import { describe, it, expect, vi } from 'vitest';
import { OllamaEmbeddingProvider } from '../../src/ollama.provider.js';

describe('OllamaEmbeddingProvider', () => {
  it('makes one request per input (Ollama API limitation)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.prompt);
      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: Array.from({ length: 4 }, (_, i) => i + body.prompt.length) }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434/',
      model: 'nomic-embed-text',
      dimensions: 4,
      fetchImpl,
    });

    const out = await provider.embed(['a', 'bb', 'ccc']);

    expect(calls).toEqual(['a', 'bb', 'ccc']);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual([1, 2, 3, 4]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects when Ollama returns empty embedding', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: [] }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434', fetchImpl });
    await expect(provider.embed(['x'])).rejects.toThrow(/empty embedding/);
  });
});
