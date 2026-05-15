import { describe, it, expect } from 'vitest';
import { chunkDoc, MAX_CHUNK_CHARS } from '../../src/doc.chunker.js';

describe('chunkDoc', () => {
  it('splits by H1/H2/H3 sections and prefixes each chunk with a breadcrumb', () => {
    const rawText = [
      '# Intro',
      'intro body',
      '',
      '## Setup',
      'setup body',
      '',
      '## Run',
      'run body',
    ].join('\n');

    const chunks = chunkDoc({
      title: 'README',
      headings: [
        { level: 1, text: 'Intro' },
        { level: 2, text: 'Setup' },
        { level: 2, text: 'Run' },
      ],
      rawText,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.breadcrumb).toBe('[README > Intro]');
    expect(chunks[1]!.breadcrumb).toBe('[README > Intro > Setup]');
    expect(chunks[2]!.breadcrumb).toBe('[README > Intro > Run]');
    expect(chunks[0]!.text.startsWith('[README > Intro]\n')).toBe(true);
    expect(chunks[0]!.text).toContain('intro body');
    expect(chunks[1]!.text).toContain('setup body');
    expect(chunks[2]!.text).toContain('run body');
  });

  it('splits an oversized section by paragraph boundary with overlap', () => {
    const para = 'a'.repeat(800);
    const big = `# Big\n${[para, para, para, para].join('\n\n')}`;
    const chunks = chunkDoc({
      title: 'Doc',
      headings: [{ level: 1, text: 'Big' }],
      rawText: big,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 64); // +breadcrumb
      expect(c.breadcrumb).toBe('[Doc > Big]');
    }
  });

  it('falls back to char-based chunking when no headings are present', () => {
    const rawText = 'lorem '.repeat(800); // ~4800 chars, no headings
    const chunks = chunkDoc({
      title: 'NoHeadings',
      headings: [],
      rawText,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.breadcrumb).toBe('[NoHeadings]');
    expect(chunks[0]!.text.startsWith('[NoHeadings]\n')).toBe(true);
    expect(chunks[0]!.headingLevel).toBe(0);
  });

  it('emits breadcrumb format [title > h1 > h2] respecting heading hierarchy', () => {
    const rawText = [
      '# Top',
      '## Sub',
      'body',
    ].join('\n');
    const chunks = chunkDoc({
      title: 'T',
      headings: [
        { level: 1, text: 'Top' },
        { level: 2, text: 'Sub' },
      ],
      rawText,
    });
    expect(chunks[chunks.length - 1]!.breadcrumb).toBe('[T > Top > Sub]');
  });
});
