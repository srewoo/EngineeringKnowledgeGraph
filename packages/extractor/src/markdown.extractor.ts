/**
 * MarkdownExtractor — pure deterministic parser for documentation files.
 *
 * Handles `.md`, `.mdx`, `.rst`, `.adoc`. Returns a normalized DocNode plus
 * code blocks and link targets. No I/O — caller supplies content + repo
 * context. Uses focused regex (not a full markdown parser) to keep the hot
 * path dependency-free and predictable.
 *
 * Doc kind is inferred from filename + path + first heading. Raw text is
 * truncated at MAX_DOC_TEXT_BYTES to avoid blowing up node properties.
 */

import { basename, extname } from 'node:path';
import {
  MAX_DOC_TEXT_BYTES,
  type CodeBlock,
  type DocHeading,
  type DocKind,
  type DocLink,
  type DocNode,
} from '@ekg/shared';

export interface MarkdownExtractionResult {
  readonly doc: DocNode;
  readonly codeBlocks: readonly CodeBlock[];
  readonly links: readonly DocLink[];
}

type DocFormat = 'markdown' | 'mdx' | 'rst' | 'adoc';

const FENCE_RE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\s*$/gm;
const INLINE_LINK_RE = /\[([^\]\n]+?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REF_DEF_RE = /^\s*\[([^\]\n]+?)\]:\s*(\S+)(?:\s+"[^"]*")?\s*$/gm;
const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export class MarkdownExtractor {
  /** True if this extractor handles the given lower-cased extension. */
  static handles(extension: string): boolean {
    const ext = extension.toLowerCase();
    return ext === '.md' || ext === '.mdx' || ext === '.rst' || ext === '.adoc';
  }

  /**
   * Parse a doc file. `relativePath` should be the repo-relative path
   * (used for kind heuristic + node id). `repoUrl` is used for the node id.
   */
  extract(content: string, relativePath: string, repoUrl: string): MarkdownExtractionResult {
    const ext = extname(relativePath).toLowerCase();
    const format = this.formatFor(ext);

    const headings = format === 'markdown' || format === 'mdx'
      ? parseMarkdownHeadings(content)
      : format === 'rst'
        ? parseRstHeadings(content)
        : parseAdocHeadings(content);

    const codeBlocks = format === 'markdown' || format === 'mdx'
      ? parseFencedCodeBlocks(content)
      : [];

    const links = format === 'markdown' || format === 'mdx'
      ? parseMarkdownLinks(content)
      : [];

    const title = headings[0]?.text ?? deriveTitleFromFilename(relativePath);
    const kind = inferDocKind(relativePath, title);
    const rawText = truncate(content, MAX_DOC_TEXT_BYTES);

    const id = `${repoUrl}:${relativePath}`;
    const doc: DocNode = {
      id,
      label: 'Doc',
      name: title || basename(relativePath),
      properties: {
        path: relativePath,
        repoUrl,
        kind,
        title,
        // Neo4j only accepts primitives and primitive arrays as node
        // properties. Serialise the structured heading objects to a flat
        // string array (`"<level>: <text>"`) so the property load is valid.
        headings: headings.map((h) => `${h.level}: ${h.text}`),
        rawText,
        codeBlockCount: codeBlocks.length,
        linkCount: links.length,
        format,
      },
    };

    return { doc, codeBlocks, links };
  }

  private formatFor(ext: string): DocFormat {
    if (ext === '.mdx') return 'mdx';
    if (ext === '.rst') return 'rst';
    if (ext === '.adoc') return 'adoc';
    return 'markdown';
  }
}

// -- Heading parsers --

function parseMarkdownHeadings(content: string): readonly DocHeading[] {
  const out: DocHeading[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceStart = /^(`{3,}|~{3,})/.exec(line);
    if (fenceStart) {
      if (!inFence) { inFence = true; fenceMarker = fenceStart[1]!; }
      else if (line.startsWith(fenceMarker)) { inFence = false; fenceMarker = ''; }
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (m) {
      out.push({ level: m[1]!.length, text: m[2]!.trim() });
      continue;
    }
    // Setext: underline of = or - on the next line
    const next = lines[i + 1];
    if (next && line.trim() && /^=+\s*$/.test(next)) {
      out.push({ level: 1, text: line.trim() });
      i++;
    } else if (next && line.trim() && /^-+\s*$/.test(next) && line.trim().length > 0) {
      out.push({ level: 2, text: line.trim() });
      i++;
    }
  }
  return out;
}

function parseRstHeadings(content: string): readonly DocHeading[] {
  // RST headings: a line of text followed by a line of identical punctuation
  // chars >= length of the title. We don't track section-char hierarchy
  // levels — just record the first as level 1, subsequent as level 2+.
  const out: DocHeading[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const text = lines[i]!.trim();
    const under = lines[i + 1] ?? '';
    if (!text) continue;
    if (/^([=\-`:'"~^_*+#])\1+\s*$/.test(under) && under.trim().length >= text.length) {
      out.push({ level: out.length === 0 ? 1 : 2, text });
      i++;
    }
  }
  return out;
}

function parseAdocHeadings(content: string): readonly DocHeading[] {
  const out: DocHeading[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const m = /^(=+)\s+(.+?)\s*$/.exec(raw);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim() });
  }
  return out;
}

// -- Code blocks (markdown only) --

function parseFencedCodeBlocks(content: string): readonly CodeBlock[] {
  const out: CodeBlock[] = [];
  // Reset regex state — FENCE_RE is module-scoped with /g.
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const info = (match[2] ?? '').trim();
    const code = match[3] ?? '';
    const lang = info.split(/\s+/)[0] ?? '';
    const startLine = content.slice(0, match.index).split(/\r?\n/).length;
    out.push({ language: lang.toLowerCase(), code, startLine });
  }
  return out;
}

// -- Links (markdown only) --

function parseMarkdownLinks(content: string): readonly DocLink[] {
  const out: DocLink[] = [];
  // Strip fenced code blocks so we don't capture links inside code.
  const stripped = content.replace(FENCE_RE, '');

  INLINE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_LINK_RE.exec(stripped)) !== null) {
    out.push({ text: m[1]!.trim(), url: m[2]!.trim() });
  }

  REF_DEF_RE.lastIndex = 0;
  while ((m = REF_DEF_RE.exec(stripped)) !== null) {
    out.push({ text: m[1]!.trim(), url: m[2]!.trim() });
  }
  return out;
}

// -- Doc kind heuristic --

export function inferDocKind(relativePath: string, title: string): DocKind {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/');
  const base = basename(lower);
  const titleLower = title.toLowerCase();

  if (base === 'changelog.md' || base === 'changelog.mdx' || base === 'changelog' || base === 'changes.md') {
    return 'CHANGELOG';
  }
  if (base.startsWith('readme.')) return 'README';
  if (base.startsWith('runbook') || lower.includes('/runbooks/')) return 'RUNBOOK';
  if (
    /\/adr\//.test(lower) ||
    /\/decisions?\//.test(lower) ||
    /^adr-?\d+/i.test(base) ||
    /^\d{3,4}-.+\.md$/.test(base)
  ) return 'ADR';
  if (lower.includes('prd') || titleLower.includes('prd') || titleLower.includes('product requirements')) {
    return 'PRD';
  }
  return 'OTHER';
}

// -- Helpers --

function deriveTitleFromFilename(relativePath: string): string {
  const base = basename(relativePath, extname(relativePath));
  return base.replace(/[-_]+/g, ' ').trim();
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // Truncate by byte budget — slice generously then trim down.
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8');
}
