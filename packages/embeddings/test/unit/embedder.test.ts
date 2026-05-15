import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embedder, chunkText } from '../../src/embedder.js';
import type { EmbeddingProvider } from '../../src/provider.interface.js';
import { EmbeddingsRepository } from '@ekg/storage';

class FakeProvider implements EmbeddingProvider {
  readonly id = 'ollama' as const;
  readonly model = 'fake';
  readonly dimensions = 4;
  callCount = 0;
  lastInputs: string[] = [];
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.callCount++;
    this.lastInputs = [...texts];
    return texts.map((t, i) => [t.length, i, 1, 0]);
  }
}

describe('chunkText', () => {
  it('returns input unchanged when shorter than chunk size', () => {
    expect(chunkText('hello', 100, 0.15)).toEqual(['hello']);
  });

  it('produces overlapping chunks', () => {
    const text = 'a'.repeat(2500);
    const chunks = chunkText(text, 1000, 0.2); // overlap 200, stride 800
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.length).toBe(1000);
    // Last chunk runs to end of text
    expect(chunks[chunks.length - 1]?.endsWith('a')).toBe(true);
  });
});

describe('Embedder', () => {
  let tempDir: string;
  let repo: EmbeddingsRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-emb-'));
    repo = new EmbeddingsRepository(join(tempDir, 'emb.db'));
  });

  afterEach(() => {
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('embeds a Function and skips on a second identical run (content-hash gating)', async () => {
    const provider = new FakeProvider();
    const embedder = new Embedder(provider, repo, 'https://example.com/repo');

    const node = {
      kind: 'Function' as const,
      nodeId: 'fn:foo',
      signature: 'function foo(): void',
      docComment: 'Does foo',
    };

    const first = await embedder.embedNodes([node]);
    expect(first.embedded).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await embedder.embedNodes([node]);
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(provider.callCount).toBe(1);
  });

  it('chunks Doc text into multiple rows with overlap', async () => {
    const provider = new FakeProvider();
    const embedder = new Embedder(provider, repo, 'https://example.com/repo');

    const big = 'lorem ipsum '.repeat(500); // ~6000 chars
    await embedder.embedNodes([{
      kind: 'Doc',
      nodeId: 'doc:readme',
      title: 'README',
      text: big,
    }]);

    expect(repo.countAll()).toBeGreaterThan(1);
    expect(provider.lastInputs.length).toBeGreaterThan(1);
  });

  it('builds Table embedding text from columns', async () => {
    const provider = new FakeProvider();
    const embedder = new Embedder(provider, repo, 'https://example.com/repo');

    await embedder.embedNodes([{
      kind: 'Table',
      nodeId: 'table:users',
      tableName: 'users',
      columns: [{ name: 'id', type: 'uuid' }, { name: 'email', type: 'text' }],
    }]);

    expect(provider.lastInputs[0]).toContain('TABLE users');
    expect(provider.lastInputs[0]).toContain('id:uuid');
    expect(provider.lastInputs[0]).toContain('email:text');
  });

  it('builds API embedding text with method/path/summary', async () => {
    const provider = new FakeProvider();
    const embedder = new Embedder(provider, repo, 'https://example.com/repo');

    await embedder.embedNodes([{
      kind: 'API',
      nodeId: 'api:GET:/users',
      method: 'get',
      path: '/users',
      summary: 'List users',
      operationId: 'listUsers',
    }]);

    expect(provider.lastInputs[0]).toContain('GET /users');
    expect(provider.lastInputs[0]).toContain('listUsers');
    expect(provider.lastInputs[0]).toContain('List users');
  });
});
