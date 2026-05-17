import { describe, it, expect } from 'vitest';
import { MarkdownExtractor, inferDocKind } from '../../src/markdown.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

describe('MarkdownExtractor', () => {
  const extractor = new MarkdownExtractor();

  describe('handles()', () => {
    it('handles markdown family extensions', () => {
      expect(MarkdownExtractor.handles('.md')).toBe(true);
      expect(MarkdownExtractor.handles('.MDX')).toBe(true);
      expect(MarkdownExtractor.handles('.rst')).toBe(true);
      expect(MarkdownExtractor.handles('.adoc')).toBe(true);
    });

    it('rejects non-doc extensions', () => {
      expect(MarkdownExtractor.handles('.ts')).toBe(false);
      expect(MarkdownExtractor.handles('.txt')).toBe(false);
    });
  });

  describe('doc-kind heuristic', () => {
    it('classifies README at repo root', () => {
      expect(inferDocKind('README.md', 'My Service')).toBe('README');
      expect(inferDocKind('packages/foo/Readme.mdx', '')).toBe('README');
    });

    it('classifies runbooks', () => {
      expect(inferDocKind('docs/runbooks/oncall.md', 'On Call')).toBe('RUNBOOK');
      expect(inferDocKind('runbook-incident.md', 'X')).toBe('RUNBOOK');
    });

    it('classifies ADRs by directory and numeric prefix', () => {
      expect(inferDocKind('docs/adr/0001-use-neo4j.md', 'Use Neo4j')).toBe('ADR');
      expect(inferDocKind('docs/decisions/0007-event-bus.md', 'Event bus')).toBe('ADR');
      expect(inferDocKind('architecture/0042-storage.md', 'Storage')).toBe('ADR');
    });

    it('classifies CHANGELOG', () => {
      expect(inferDocKind('CHANGELOG.md', '')).toBe('CHANGELOG');
      expect(inferDocKind('packages/x/CHANGELOG.md', 'Changes')).toBe('CHANGELOG');
    });

    it('classifies PRDs by path or title', () => {
      expect(inferDocKind('docs/prd-v2.md', 'Spec')).toBe('PRD');
      expect(inferDocKind('docs/spec.md', 'Product Requirements: Foo')).toBe('PRD');
    });

    it('falls back to OTHER', () => {
      expect(inferDocKind('docs/contributing.md', 'Contributing')).toBe('OTHER');
    });
  });

  describe('markdown structure parsing', () => {
    it('extracts H1 as title and full heading hierarchy', () => {
      const md = [
        '# Service X',
        '',
        '## Overview',
        '',
        '### Details',
        '',
        '## Setup',
      ].join('\n');
      const r = extractor.extract(md, 'README.md', REPO);
      const props = r.doc.properties;
      expect(props.title).toBe('Service X');
      expect(r.headings).toEqual([
        { level: 1, text: 'Service X' },
        { level: 2, text: 'Overview' },
        { level: 3, text: 'Details' },
        { level: 2, text: 'Setup' },
      ]);
      expect(props.headingLevels).toEqual([1, 2, 3, 2]);
      expect(props.headingTexts).toEqual(['Service X', 'Overview', 'Details', 'Setup']);
      expect(r.doc.id).toBe(`${REPO}:README.md`);
      expect(props.kind).toBe('README');
      expect(props.format).toBe('markdown');
    });

    it('extracts setext-style headings', () => {
      const md = ['Title Here', '==========', '', 'Sub', '---'].join('\n');
      const r = extractor.extract(md, 'docs/x.md', REPO);
      expect(r.headings).toEqual([
        { level: 1, text: 'Title Here' },
        { level: 2, text: 'Sub' },
      ]);
    });

    it('ignores headings inside fenced code blocks', () => {
      const md = ['# Real', '', '```', '# Fake heading', '```', '', '## Also Real'].join('\n');
      const r = extractor.extract(md, 'README.md', REPO);
      expect(r.headings.map((h) => h.text)).toEqual(['Real', 'Also Real']);
    });

    it('extracts fenced code blocks with and without language', () => {
      const md = [
        '# X',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '```',
        'plain text',
        '```',
        '',
        '~~~python',
        'print("hi")',
        '~~~',
      ].join('\n');
      const r = extractor.extract(md, 'README.md', REPO);
      expect(r.codeBlocks.length).toBe(3);
      const langs = r.codeBlocks.map((b) => b.language);
      expect(langs).toContain('ts');
      expect(langs).toContain('python');
      expect(langs).toContain(''); // no-language block
      const ts = r.codeBlocks.find((b) => b.language === 'ts')!;
      expect(ts.code).toContain('const a = 1;');
      expect(ts.startLine).toBeGreaterThan(0);
      expect(r.doc.properties.codeBlockCount).toBe(3);
    });

    it('extracts inline and reference-style links, skips links inside code', () => {
      const md = [
        '# Docs',
        '',
        'See [home](https://example.com) and [api](https://api.example.com "title").',
        '',
        '[ref]: https://ref.example.com "Ref"',
        '',
        '```',
        '[fake](https://nope.example.com)',
        '```',
      ].join('\n');
      const r = extractor.extract(md, 'README.md', REPO);
      const urls = r.links.map((l) => l.url);
      expect(urls).toContain('https://example.com');
      expect(urls).toContain('https://api.example.com');
      expect(urls).toContain('https://ref.example.com');
      expect(urls).not.toContain('https://nope.example.com');
      expect(r.doc.properties.linkCount).toBe(r.links.length);
    });
  });

  describe('non-markdown formats', () => {
    it('parses RST title from underlined first heading', () => {
      const rst = [
        'My Project',
        '==========',
        '',
        'Some content.',
        '',
        'Section',
        '-------',
      ].join('\n');
      const r = extractor.extract(rst, 'docs/index.rst', REPO);
      expect(r.doc.properties.title).toBe('My Project');
      expect(r.doc.properties.format).toBe('rst');
      expect(r.doc.properties.rawText).toContain('Some content.');
      expect(r.codeBlocks.length).toBe(0);
    });

    it('parses AsciiDoc heading levels', () => {
      const adoc = ['= Top', '', '== Sub', '', 'Body'].join('\n');
      const r = extractor.extract(adoc, 'docs/x.adoc', REPO);
      expect(r.doc.properties.title).toBe('Top');
      expect(r.doc.properties.format).toBe('adoc');
      expect(r.headings).toEqual([
        { level: 1, text: 'Top' },
        { level: 2, text: 'Sub' },
      ]);
    });
  });

  describe('regression: real-world README', () => {
    it('parses a mixed README end-to-end', () => {
      const md = [
        '# CodeSage',
        '',
        'Engineering Knowledge Graph for monorepos.',
        '',
        '## Quick start',
        '',
        'Install with [npm](https://npmjs.com):',
        '',
        '```bash',
        'npm install',
        'npm run build',
        '```',
        '',
        '## Architecture',
        '',
        'See the [ADR index](./docs/adr/README.md).',
        '',
        '### Components',
        '',
        '- Parser',
        '- Extractor',
        '',
        '```ts',
        'const x: number = 42;',
        '```',
      ].join('\n');
      const r = extractor.extract(md, 'README.md', REPO);
      expect(r.doc.properties.kind).toBe('README');
      expect(r.doc.properties.title).toBe('CodeSage');
      expect(r.headings.length).toBe(4);
      expect(r.codeBlocks.length).toBe(2);
      expect(r.codeBlocks.map((b) => b.language).sort()).toEqual(['bash', 'ts']);
      expect(r.links.map((l) => l.url)).toEqual(
        expect.arrayContaining(['https://npmjs.com', './docs/adr/README.md']),
      );
      expect(r.doc.label).toBe('Doc');
      expect(r.doc.id).toBe(`${REPO}:README.md`);
    });
  });
});
