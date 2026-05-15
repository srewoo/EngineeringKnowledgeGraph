import { describe, it, expect, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/openai.provider.js';

function mockOk(vectors: number[][]): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((v) => ({ embedding: v })) }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

function mockStatus(status: number, body: string): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe('OpenAIEmbeddingProvider', () => {
  it('rejects construction without an API key', () => {
    expect(() => new OpenAIEmbeddingProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('posts to /v1/embeddings with model + inputs', async () => {
    const fetchImpl = mockOk([[0.1, 0.2, 0.3]]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 3,
      fetchImpl,
    });

    const out = await provider.embed(['hello world']);

    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(['hello world']);
  });

  it('batches inputs in chunks of 100', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.input.length);
      const vectors = (body.input as string[]).map(() => [0]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: vectors.map((v) => ({ embedding: v })) }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk', dimensions: 1, fetchImpl });
    const inputs = Array.from({ length: 250 }, (_, i) => `item-${i}`);
    const out = await provider.embed(inputs);

    expect(out).toHaveLength(250);
    expect(calls).toEqual([100, 100, 50]);
  });

  it('retries on 429 then succeeds', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2] }] }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk', dimensions: 2, fetchImpl });
    const out = await provider.embed(['x']);
    expect(out).toEqual([[1, 2]]);
    expect(attempt).toBe(2);
  });

  it('does not retry on 400', async () => {
    const fetchImpl = mockStatus(400, 'bad request');
    const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk', dimensions: 1, fetchImpl });
    await expect(provider.embed(['x'])).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
