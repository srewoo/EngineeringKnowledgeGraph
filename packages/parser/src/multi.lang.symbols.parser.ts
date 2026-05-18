/**
 * MultiLangSymbolsParser — regex-based function/class extraction for
 * languages where we don't run a full AST.
 *
 * Currently handles Python and Go. Emits ParsedSymbols (functions, classes,
 * methods, typeDefs) compatible with `SymbolsExtractor`. Calls and typeUses
 * stay empty — those need an AST to do reliably.
 *
 * Design notes:
 *  - Bounded regex; never backtracks catastrophically (no nested `+`/`*`).
 *  - We do not infer cyclomatic complexity here (no AST) — set to 0.
 *  - `signature` is the raw declarator line, trimmed.
 */

import type { ParsedSymbols, ParsedFunction, ParsedClass, ParsedMethod } from '@ekg/shared';

export type SupportedSymbolsLanguage = 'python' | 'go';

const EXT_TO_LANG: Readonly<Record<string, SupportedSymbolsLanguage>> = {
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
};

export class MultiLangSymbolsParser {
  static handles(extension: string): boolean {
    return extension.toLowerCase() in EXT_TO_LANG;
  }

  static detectLanguage(extension: string): SupportedSymbolsLanguage | undefined {
    return EXT_TO_LANG[extension.toLowerCase()];
  }

  parse(content: string, filePath: string, language: SupportedSymbolsLanguage): ParsedSymbols {
    if (language === 'python') return parsePython(content, filePath);
    return parseGo(content, filePath);
  }
}

// --- Python ---

const PY_DEF_RE =
  /^(?<indent>[ \t]*)(?<dec>(?:@[A-Za-z_][\w.]*(?:\([^)]*\))?\s*\n[ \t]*)*)?(?<async>async\s+)?def\s+(?<name>[A-Za-z_][\w]*)\s*\((?<sig>[^)]*)\)\s*(?:->\s*[^:]+)?\s*:/gm;
const PY_CLASS_RE =
  /^(?<indent>[ \t]*)class\s+(?<name>[A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:/gm;

function parsePython(content: string, filePath: string): ParsedSymbols {
  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const methods: ParsedMethod[] = [];

  // First pass: classes — we need their indent level + line span to attribute methods.
  const classSpans: Array<{ name: string; id: string; indent: number; start: number; end: number }> = [];
  PY_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_CLASS_RE.exec(content))) {
    const indent = (m.groups?.['indent'] ?? '').length;
    const name = m.groups?.['name'] ?? '';
    if (!name) continue;
    const start = lineOf(content, m.index);
    const end = pythonBlockEndLine(content, m.index, indent);
    const id = symbolId(filePath, name, start, 'cls');
    classes.push({
      id,
      name,
      lineStart: start,
      lineEnd: end,
      isExported: !name.startsWith('_'),
      isAbstract: false,
    });
    classSpans.push({ name, id, indent, start, end });
  }

  // Second pass: defs — attribute to a class iff the def is inside its line span and indent > class.indent.
  PY_DEF_RE.lastIndex = 0;
  while ((m = PY_DEF_RE.exec(content))) {
    const indent = (m.groups?.['indent'] ?? '').length;
    const name = m.groups?.['name'] ?? '';
    const sig = m.groups?.['sig'] ?? '';
    const isAsync = Boolean(m.groups?.['async']);
    if (!name) continue;
    const lineStart = lineOf(content, m.index);
    const lineEnd = pythonBlockEndLine(content, m.index, indent);
    const docComment = pythonDocstring(content, m.index + m[0].length);
    const owner = classSpans.find(
      (c) => lineStart > c.start && lineStart <= c.end && indent > c.indent,
    );
    if (owner) {
      methods.push({
        id: symbolId(filePath, `${owner.name}.${name}`, lineStart, 'method'),
        classId: owner.id,
        name,
        signature: signature(name, sig),
        ...(docComment ? { docComment } : {}),
        lineStart,
        lineEnd,
        isStatic: name === '__new__' || sig.trim().startsWith('cls'),
        isAsync,
        visibility: name.startsWith('__') && !name.endsWith('__') ? 'private'
          : name.startsWith('_') ? 'protected'
          : 'public',
        complexity: 0,
      });
    } else {
      functions.push({
        id: symbolId(filePath, name, lineStart),
        name,
        signature: signature(name, sig),
        ...(docComment ? { docComment } : {}),
        lineStart,
        lineEnd,
        isExported: !name.startsWith('_'),
        isAsync,
        complexity: 0,
      });
    }
  }

  return { functions, classes, methods, typeDefs: [], calls: [], typeUses: [] };
}

/** End line of a Python block whose header started at `headerIdx` with indent `headerIndent`. */
function pythonBlockEndLine(content: string, headerIdx: number, headerIndent: number): number {
  // Skip past the rest of the header line.
  const nl = content.indexOf('\n', headerIdx);
  if (nl < 0) return lineOf(content, content.length);
  let i = nl + 1;
  let lastBodyLine = lineOf(content, headerIdx);
  while (i < content.length) {
    const lineEnd = content.indexOf('\n', i);
    const line = lineEnd < 0 ? content.slice(i) : content.slice(i, lineEnd);
    if (line.trim().length > 0) {
      const indent = leadingSpaces(line);
      if (indent <= headerIndent) break;
      lastBodyLine = lineOf(content, i);
    }
    if (lineEnd < 0) break;
    i = lineEnd + 1;
  }
  return lastBodyLine;
}

function pythonDocstring(content: string, headerEndIdx: number): string | undefined {
  // Look for """...""" or '''...''' on the next non-blank line.
  let i = headerEndIdx;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t' || content[i] === '\n' || content[i] === '\r')) i++;
  const triple = content.slice(i, i + 3);
  if (triple !== '"""' && triple !== "'''") return undefined;
  const close = content.indexOf(triple, i + 3);
  if (close < 0) return undefined;
  return content.slice(i + 3, close).trim();
}

// --- Go ---

const GO_FUNC_RE =
  /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_][\w]*)\s*(\[[^\]]*\])?\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([A-Za-z_][\w*\[\].]*))?\s*\{/gm;
const GO_TYPE_RE =
  /^type\s+([A-Z][\w]*)\s+struct\b/gm;
const GO_DOC_RE = /((?:[ \t]*\/\/[^\n]*\n)+)[ \t]*$/;

function parseGo(content: string, filePath: string): ParsedSymbols {
  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const methods: ParsedMethod[] = [];

  // Struct types act as "classes" for receiver-method attribution.
  const structIds = new Map<string, string>();
  GO_TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GO_TYPE_RE.exec(content))) {
    const name = m[1]!;
    const start = lineOf(content, m.index);
    const end = goBraceBlockEndLine(content, m.index);
    const id = symbolId(filePath, name, start, 'cls');
    structIds.set(name, id);
    classes.push({
      id,
      name,
      lineStart: start,
      lineEnd: end,
      isExported: /^[A-Z]/.test(name),
      isAbstract: false,
    });
  }

  GO_FUNC_RE.lastIndex = 0;
  while ((m = GO_FUNC_RE.exec(content))) {
    const receiver = m[1] ?? '';
    const name = m[2]!;
    const params = m[4] ?? '';
    const ret = m[5] ?? m[6] ?? '';
    const lineStart = lineOf(content, m.index);
    const lineEnd = goBraceBlockEndLine(content, m.index + m[0].length - 1);
    const sig = `${name}(${params.trim()})${ret ? ` ${ret.trim()}` : ''}`;
    const before = content.slice(Math.max(0, m.index - 400), m.index);
    const docMatch = GO_DOC_RE.exec(before);
    const docComment = docMatch
      ? docMatch[1]!
          .split('\n')
          .map((l) => l.replace(/^[ \t]*\/\/\s?/, ''))
          .filter((l) => l.length > 0)
          .join('\n')
          .trim() || undefined
      : undefined;

    if (receiver) {
      // `(r *Foo)` or `(r Foo)` or `(Foo)` — pick the type ident.
      const recvType = (receiver.match(/\*?([A-Z][\w]*)/)?.[1]) ?? '';
      const classId = structIds.get(recvType);
      if (classId) {
        methods.push({
          id: symbolId(filePath, `${recvType}.${name}`, lineStart, 'method'),
          classId,
          name,
          signature: sig,
          ...(docComment ? { docComment } : {}),
          lineStart,
          lineEnd,
          isStatic: false,
          isAsync: false,
          visibility: /^[A-Z]/.test(name) ? 'public' : 'private',
          complexity: 0,
        });
        continue;
      }
    }
    functions.push({
      id: symbolId(filePath, name, lineStart),
      name,
      signature: sig,
      ...(docComment ? { docComment } : {}),
      lineStart,
      lineEnd,
      isExported: /^[A-Z]/.test(name),
      isAsync: false,
      complexity: 0,
    });
  }

  return { functions, classes, methods, typeDefs: [], calls: [], typeUses: [] };
}

function goBraceBlockEndLine(content: string, openHintIdx: number): number {
  // Walk forward to the next `{`, then match braces.
  let i = openHintIdx;
  while (i < content.length && content[i] !== '{') i++;
  if (i >= content.length) return lineOf(content, content.length);
  let depth = 0;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return lineOf(content, i);
    }
  }
  return lineOf(content, content.length);
}

// --- helpers ---

function lineOf(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') n++;
    else break;
  }
  return n;
}

function signature(name: string, args: string): string {
  return `${name}(${args.trim()})`;
}

type SymbolKind = 'fn' | 'cls' | 'method';
function symbolId(filePath: string, name: string, line: number, kind: SymbolKind = 'fn'): string {
  // Prefix matches what SymbolsExtractor.isLocalId accepts so the pipeline
  // rewriter prepends the repoUrl correctly.
  return `${kind}:${filePath}:${name}@${line}`;
}
