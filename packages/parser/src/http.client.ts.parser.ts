/**
 * HTTP client extractor for TypeScript / JavaScript (Phase 1.5 follow-ups).
 *
 * Walks a ts-morph SourceFile and emits ParsedHttpCallSite[] — a richer,
 * line-tagged form of `ParsedHttpCall` so the downstream URL→API resolver
 * can attach edges back to the calling Function/Method.
 *
 * Detected forms (deterministic, no LLM):
 *   - `fetch(url, ...)` (when node-fetch / undici / globals are imported)
 *   - `axios(url, ...)`, `axios.get(url)`, `axios.post(url, body)`
 *   - `httpClient.request({ url })` / `axios.create()` instance chains
 *   - `got(url)`, `got.get(url)`
 *
 * URL literals captured: plain string, no-substitution template, and
 * template-with-substitutions (preserving `${var}` so the resolver can
 * still match by path fragment).
 *
 * `callerSymbolId` is the closest enclosing function/method's symbol id
 * (`fn:<fileId>:<name>:<line>` / `method:<classId>:<name>:<line>`) when
 * derivable — otherwise undefined.
 */

import { SyntaxKind, type SourceFile, type CallExpression, type Node } from 'ts-morph';
import type { ParsedHttpCallSite, ParsedImport } from '@ekg/shared';
import { HTTP_CLIENT_PACKAGES } from '@ekg/shared';

const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request',
]);

export class HttpClientTypeScriptExtractor {
  /**
   * Extract HTTP call sites. `fileId` is used to build `callerSymbolId`
   * (`fn:<fileId>:<name>:<line>`) — it must match the convention used by
   * `TypeScriptSymbolsParser`.
   */
  extract(
    source: SourceFile,
    imports: readonly ParsedImport[],
    fileId: string,
  ): readonly ParsedHttpCallSite[] {
    const httpImports = imports.filter((imp) => HTTP_CLIENT_PACKAGES.includes(imp.source));
    if (httpImports.length === 0) return [];

    const clientIds = buildClientIdentifiers(httpImports);
    const out: ParsedHttpCallSite[] = [];

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const site = matchCallSite(call, clientIds, httpImports[0]?.source ?? 'unknown');
      if (!site) continue;
      const callerSymbolId = findEnclosingSymbolId(call, fileId);
      out.push(callerSymbolId ? { ...site, callerSymbolId } : site);
    }
    return out;
  }
}

function buildClientIdentifiers(httpImports: readonly ParsedImport[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const imp of httpImports) {
    for (const spec of imp.specifiers) ids.add(spec.replace(/^\*\s+as\s+/, ''));
    const tail = imp.source.split('/').pop() ?? imp.source;
    ids.add(tail);
  }
  if (httpImports.some((i) => i.source === 'node-fetch' || i.source === 'undici')) {
    ids.add('fetch');
  }
  return ids;
}

function matchCallSite(
  call: CallExpression,
  clientIds: ReadonlySet<string>,
  defaultClientLib: string,
): ParsedHttpCallSite | undefined {
  const expr = call.getExpression();
  let receiver: string | undefined;
  let method = 'GET';
  let isCall = false;

  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const prop = expr.asKind(SyntaxKind.PropertyAccessExpression);
    const propName = prop?.getName()?.toLowerCase();
    const recvText = prop?.getExpression().getText() ?? '';
    if (propName && HTTP_METHODS.has(propName) && matchesClientId(recvText, clientIds)) {
      receiver = recvText;
      method = propName.toUpperCase();
      isCall = true;
    }
  } else if (expr.getKind() === SyntaxKind.Identifier) {
    const name = expr.getText();
    if (clientIds.has(name) && (name === 'fetch' || name === 'axios' || name === 'got' || name === 'ky')) {
      receiver = name;
      isCall = true;
    }
  }

  if (!isCall) return undefined;
  const args = call.getArguments();
  if (args.length === 0) return undefined;

  const urlInfo = extractUrlLiteral(args[0]!);
  if (!urlInfo) return undefined;
  if (!isUrlLike(urlInfo.url)) return undefined;

  return {
    url: urlInfo.url,
    method,
    clientLibrary: receiver ?? defaultClientLib,
    sourceLine: call.getStartLineNumber(),
    isTemplate: urlInfo.isTemplate,
  };
}

function matchesClientId(receiver: string, ids: ReadonlySet<string>): boolean {
  if (!receiver) return false;
  if (ids.has(receiver)) return true;
  const head = receiver.split(/[.\(\[]/)[0] ?? '';
  return ids.has(head);
}

function extractUrlLiteral(
  node: Node,
): { url: string; isTemplate: boolean } | undefined {
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return { url: node.getText().slice(1, -1), isTemplate: false };
  }
  if (kind === SyntaxKind.TemplateExpression) {
    const raw = node.getText().slice(1, -1);
    return { url: raw.replace(/\$\{[^}]*\}/g, '{var}'), isTemplate: true };
  }
  return undefined;
}

function isUrlLike(url: string): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://')
    || url.startsWith('/') || url.startsWith('{var}');
}

/**
 * Walk up the AST to find the nearest enclosing function/method declaration
 * and synthesise a symbol id matching `TypeScriptSymbolsParser`'s convention.
 */
function findEnclosingSymbolId(node: Node, fileId: string): string | undefined {
  let current: Node | undefined = node.getParent();
  while (current) {
    const k = current.getKind();
    if (k === SyntaxKind.FunctionDeclaration) {
      const name = current.asKind(SyntaxKind.FunctionDeclaration)?.getName();
      if (name) return `fn:${fileId}:${name}:${current.getStartLineNumber()}`;
      return undefined;
    }
    if (k === SyntaxKind.MethodDeclaration) {
      const m = current.asKind(SyntaxKind.MethodDeclaration);
      const cls = m?.getParentIfKind(SyntaxKind.ClassDeclaration);
      const className = cls?.getName();
      const methodName = m?.getName();
      if (className && methodName && cls) {
        const classId = `cls:${fileId}:${className}:${cls.getStartLineNumber()}`;
        return `method:${classId}:${methodName}:${current.getStartLineNumber()}`;
      }
      return undefined;
    }
    if (k === SyntaxKind.VariableDeclaration) {
      const vd = current.asKind(SyntaxKind.VariableDeclaration);
      const init = vd?.getInitializer();
      if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) {
        const name = vd?.getName();
        if (name) return `fn:${fileId}:${name}:${current.getStartLineNumber()}`;
      }
    }
    current = current.getParent();
  }
  return undefined;
}
