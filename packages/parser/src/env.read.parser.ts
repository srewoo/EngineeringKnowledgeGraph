/**
 * Env-var read parser for TypeScript / JavaScript (Phase 1.6 follow-ups).
 *
 * Walks a ts-morph SourceFile and emits `ParsedEnvRead[]` — one entry per
 * source-code site that reads an environment variable. Downstream the
 * `EnvReadResolver` matches `read.key` to emitted `ConfigKey.key` and emits
 * `Function|Method -[READS_CONFIG]-> ConfigKey` edges.
 *
 * Detected forms (deterministic, no LLM):
 *   - `process.env.FOO` (PropertyAccessExpression)
 *   - `process.env['FOO']` / `process.env["FOO"]` (ElementAccessExpression)
 *   - `process.env[FOO_CONST]` where `FOO_CONST` is a same-file string-literal
 *     const binding (MEDIUM confidence; otherwise skipped).
 *   - `Bun.env.FOO`, `Deno.env.get('FOO')`, `Deno.env.toObject().FOO`.
 *
 * `callerSymbolId` matches the convention used by `TypeScriptSymbolsParser` /
 * `HttpClientTypeScriptExtractor` — `fn:<fileId>:<name>:<line>` or
 * `method:<classId>:<name>:<line>` — so the extractor's per-repo prefix
 * rewrite is sufficient to make ids match File-bound symbol nodes.
 */

import { SyntaxKind, type SourceFile, type Node } from 'ts-morph';
import type { ParsedEnvRead } from '@ekg/shared';

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export class EnvReadParser {
  /**
   * Extract env-var read sites. `fileId` is the symbol-id prefix used by
   * `TypeScriptSymbolsParser`, i.e. the same string passed there.
   */
  extract(source: SourceFile, fileId: string): readonly ParsedEnvRead[] {
    const out: ParsedEnvRead[] = [];
    const stringConsts = collectStringConsts(source);

    for (const access of source.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const hit = matchPropertyAccess(access);
      if (!hit) continue;
      out.push({
        key: hit.key,
        sourceLine: access.getStartLineNumber(),
        confidence: 'HIGH',
        kind: 'env',
        ...maybeCaller(access, fileId),
      });
    }

    for (const access of source.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
      const hit = matchElementAccess(access, stringConsts);
      if (!hit) continue;
      out.push({
        key: hit.key,
        sourceLine: access.getStartLineNumber(),
        confidence: hit.confidence,
        kind: 'env',
        ...maybeCaller(access, fileId),
      });
    }

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const hit = matchDenoEnvGet(call);
      if (!hit) continue;
      out.push({
        key: hit.key,
        sourceLine: call.getStartLineNumber(),
        confidence: 'HIGH',
        kind: 'env',
        ...maybeCaller(call, fileId),
      });
    }

    return dedupe(out);
  }
}

// -- Pattern matchers --------------------------------------------------------

interface KeyHit {
  readonly key: string;
  readonly confidence: 'HIGH' | 'MEDIUM';
}

function matchPropertyAccess(node: Node): KeyHit | undefined {
  const text = node.getText();
  // process.env.FOO  |  Bun.env.FOO  |  Deno.env.toObject().FOO
  const direct = /^(?:process|Bun)\.env\.([A-Z_][A-Z0-9_]*)$/.exec(text);
  if (direct?.[1]) return { key: direct[1], confidence: 'HIGH' };
  const denoChained = /^Deno\.env\.toObject\(\)\.([A-Z_][A-Z0-9_]*)$/.exec(text);
  if (denoChained?.[1]) return { key: denoChained[1], confidence: 'HIGH' };
  return undefined;
}

function matchElementAccess(
  node: Node,
  stringConsts: ReadonlyMap<string, string>,
): KeyHit | undefined {
  const access = node.asKind(SyntaxKind.ElementAccessExpression);
  if (!access) return undefined;
  const recv = access.getExpression().getText();
  if (recv !== 'process.env' && recv !== 'Bun.env') return undefined;
  const arg = access.getArgumentExpression();
  if (!arg) return undefined;

  const k = arg.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const literal = arg.getText().slice(1, -1);
    return ENV_NAME_RE.test(literal) ? { key: literal, confidence: 'HIGH' } : undefined;
  }
  if (k === SyntaxKind.Identifier) {
    const resolved = stringConsts.get(arg.getText());
    if (resolved && ENV_NAME_RE.test(resolved)) {
      return { key: resolved, confidence: 'MEDIUM' };
    }
  }
  return undefined;
}

function matchDenoEnvGet(node: Node): KeyHit | undefined {
  const call = node.asKind(SyntaxKind.CallExpression);
  if (!call) return undefined;
  const expr = call.getExpression();
  if (expr.getText() !== 'Deno.env.get') return undefined;
  const args = call.getArguments();
  const first = args[0];
  if (!first) return undefined;
  const k = first.getKind();
  if (k !== SyntaxKind.StringLiteral && k !== SyntaxKind.NoSubstitutionTemplateLiteral) {
    return undefined;
  }
  const literal = first.getText().slice(1, -1);
  return ENV_NAME_RE.test(literal) ? { key: literal, confidence: 'HIGH' } : undefined;
}

// -- Same-file const resolution ---------------------------------------------

/**
 * Collect simple `const FOO = 'BAR'` bindings (and `let`/`var`) in the file
 * for best-effort resolution of `process.env[FOO]` indirections. Bounded
 * to literal-only initialisers; no cross-file lookup.
 */
function collectStringConsts(source: SourceFile): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const v of source.getVariableStatements()) {
    for (const decl of v.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const k = init.getKind();
      if (k !== SyntaxKind.StringLiteral && k !== SyntaxKind.NoSubstitutionTemplateLiteral) continue;
      out.set(decl.getName(), init.getText().slice(1, -1));
    }
  }
  return out;
}

// -- Caller-symbol resolution ------------------------------------------------

function maybeCaller(node: Node, fileId: string): { callerSymbolId?: string } {
  const id = findEnclosingSymbolId(node, fileId);
  return id ? { callerSymbolId: id } : {};
}

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

function dedupe(reads: readonly ParsedEnvRead[]): readonly ParsedEnvRead[] {
  const seen = new Set<string>();
  const out: ParsedEnvRead[] = [];
  for (const r of reads) {
    const key = `${r.key}|${r.sourceLine}|${r.callerSymbolId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
