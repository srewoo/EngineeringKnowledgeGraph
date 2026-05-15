/**
 * Heading-aware doc chunker.
 *
 * If headings are present, splits a document by section: each H1/H2/H3 starts
 * a new chunk and includes its body until the next same-or-higher heading.
 * If a chunk exceeds MAX_CHUNK_CHARS, splits mid-section by paragraph
 * boundary, preserving 15% overlap. Each chunk is prefixed with a breadcrumb
 * line so vector hits return useful citation context.
 *
 * Pure deterministic: no I/O, no LLM. Reuses the heading shape produced by
 * `MarkdownExtractor` (Phase 1.2).
 */

import type { DocHeading } from '@ekg/shared';

export const MAX_CHUNK_CHARS = 2000;
export const DOC_OVERLAP_RATIO = 0.15;
const SECTION_HEADING_MAX_LEVEL = 3;

export interface DocChunkInput {
  readonly title: string;
  readonly headings: readonly DocHeading[];
  readonly rawText: string;
}

export interface DocChunk {
  readonly text: string;
  readonly breadcrumb: string;
  readonly headingLevel: number;
  readonly lineRange: readonly [number, number];
}

interface HeadingHit {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

/**
 * Chunk a document. Returns at least one chunk (the breadcrumb-prefixed full
 * title + body) even when the document is tiny.
 */
export function chunkDoc(input: DocChunkInput): readonly DocChunk[] {
  const lines = input.rawText.split(/\r?\n/);
  const hits = locateHeadings(input.headings, lines).filter((h) => h.level <= SECTION_HEADING_MAX_LEVEL);

  if (hits.length === 0) {
    return fallbackChunks(input.title, input.rawText, lines.length);
  }

  const chunks: DocChunk[] = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]!;
    const endLine = i + 1 < hits.length ? hits[i + 1]!.line : lines.length;
    const sectionText = lines.slice(start.line - 1, endLine).join('\n');
    const stack = headingStack(hits, i);
    const breadcrumb = renderBreadcrumb(input.title, stack);
    for (const piece of splitOversized(sectionText)) {
      chunks.push({
        text: `${breadcrumb}\n${piece.text}`,
        breadcrumb,
        headingLevel: start.level,
        lineRange: [start.line + piece.lineOffset, Math.min(endLine, start.line + piece.lineOffset + piece.lineSpan)],
      });
    }
  }
  return chunks;
}

// -- helpers --

function locateHeadings(headings: readonly DocHeading[], lines: readonly string[]): readonly HeadingHit[] {
  // MarkdownExtractor today emits {level, text} without line info. Locate
  // each by scanning the lines in order; same-text duplicates fall back to
  // the next match after the previous hit.
  const out: HeadingHit[] = [];
  let cursor = 0;
  for (const h of headings) {
    const idx = findHeadingLine(lines, h.text, cursor);
    if (idx >= 0) {
      out.push({ level: h.level, text: h.text, line: idx + 1 });
      cursor = idx + 1;
    }
  }
  return out;
}

function findHeadingLine(lines: readonly string[], text: string, fromIdx: number): number {
  const needle = text.trim();
  for (let i = fromIdx; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    // ATX `# heading`, AsciiDoc `= heading`, or plain setext line equals text.
    if (line === needle) return i;
    const stripped = line.replace(/^#{1,6}\s+/, '').replace(/^=+\s+/, '').replace(/\s+#*\s*$/, '').trim();
    if (stripped === needle) return i;
  }
  return -1;
}

function headingStack(hits: readonly HeadingHit[], idx: number): readonly HeadingHit[] {
  const stack: HeadingHit[] = [];
  for (let i = 0; i <= idx; i++) {
    const h = hits[i]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack;
}

function renderBreadcrumb(title: string, stack: readonly HeadingHit[]): string {
  const parts = [title.trim(), ...stack.map((h) => h.text.trim())].filter((s) => s.length > 0);
  return `[${parts.join(' > ')}]`;
}

interface SectionPiece {
  readonly text: string;
  readonly lineOffset: number;
  readonly lineSpan: number;
}

function splitOversized(sectionText: string): readonly SectionPiece[] {
  if (sectionText.length <= MAX_CHUNK_CHARS) {
    return [{ text: sectionText, lineOffset: 0, lineSpan: sectionText.split(/\r?\n/).length }];
  }
  const overlap = Math.floor(MAX_CHUNK_CHARS * DOC_OVERLAP_RATIO);
  const stride = Math.max(1, MAX_CHUNK_CHARS - overlap);
  const pieces: SectionPiece[] = [];
  let pos = 0;
  while (pos < sectionText.length) {
    const slice = sectionText.slice(pos, pos + MAX_CHUNK_CHARS);
    const cut = preferParagraphBoundary(slice);
    const text = slice.slice(0, cut);
    const lineOffset = sectionText.slice(0, pos).split(/\r?\n/).length - 1;
    const lineSpan = text.split(/\r?\n/).length;
    pieces.push({ text, lineOffset, lineSpan });
    if (pos + cut >= sectionText.length) break;
    pos += Math.max(stride, cut - overlap);
  }
  return pieces;
}

function preferParagraphBoundary(slice: string): number {
  if (slice.length < MAX_CHUNK_CHARS) return slice.length;
  // Prefer the last blank line within the slice; fall back to last newline,
  // then a hard cut at MAX_CHUNK_CHARS.
  const blank = slice.lastIndexOf('\n\n');
  if (blank > MAX_CHUNK_CHARS / 2) return blank + 2;
  const nl = slice.lastIndexOf('\n');
  if (nl > MAX_CHUNK_CHARS / 2) return nl + 1;
  return slice.length;
}

function fallbackChunks(title: string, rawText: string, lineCount: number): readonly DocChunk[] {
  const breadcrumb = `[${title.trim()}]`;
  if (rawText.length <= MAX_CHUNK_CHARS) {
    return [{
      text: `${breadcrumb}\n${rawText}`,
      breadcrumb,
      headingLevel: 0,
      lineRange: [1, lineCount],
    }];
  }
  const overlap = Math.floor(MAX_CHUNK_CHARS * DOC_OVERLAP_RATIO);
  const stride = Math.max(1, MAX_CHUNK_CHARS - overlap);
  const out: DocChunk[] = [];
  for (let pos = 0; pos < rawText.length; pos += stride) {
    const slice = rawText.slice(pos, pos + MAX_CHUNK_CHARS);
    if (slice.length === 0) break;
    const startLine = rawText.slice(0, pos).split(/\r?\n/).length;
    const endLine = startLine + slice.split(/\r?\n/).length - 1;
    out.push({
      text: `${breadcrumb}\n${slice}`,
      breadcrumb,
      headingLevel: 0,
      lineRange: [startLine, endLine],
    });
    if (pos + MAX_CHUNK_CHARS >= rawText.length) break;
  }
  return out;
}
