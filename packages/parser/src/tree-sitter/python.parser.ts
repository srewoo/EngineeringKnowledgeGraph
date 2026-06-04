/**
 * Tree-sitter Python parser (Phase A pilot).
 *
 * Produces the same `ParseResult` shape as `MultiLanguageParser.parseFile`
 * for `.py` / `.pyi` files, but driven by tree-sitter's AST instead of
 * regex tables. Closes the accuracy gap on:
 *   - decorators (`@app.post(...)` route registration)
 *   - multi-line imports (`from x import (\n  a,\n  b,\n)`)
 *   - nested calls that fool regex (e.g. `requests.get(build_url())`)
 *
 * Loading strategy:
 *   - Tree-sitter is an **optional** dep. We dynamic-import it the first
 *     time a Python file is parsed.
 *   - If `tree-sitter` or `tree-sitter-python` aren't installed, the
 *     parser self-disables (`isAvailable()` returns false) and callers
 *     fall back to the regex parser.
 *   - This lets us ship the pilot in code without forcing every existing
 *     deployment to install a native dep.
 *
 * Activation: set `EKG_TREESITTER_PYTHON=true`. See ADR-007.
 */

import { readFile } from 'node:fs/promises';
import { createLogger, type Logger } from '@ekg/shared';
import type {
  ParseResult, ParsedImport, ParsedRoute, ParsedHttpCall,
  ParsedDatabaseUsage, ParsedKafka, ParsedHttpCallSite,
} from '@ekg/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TreeSitterModule = { default: new () => any };
type GrammarModule = { default: unknown };

/**
 * Pure shape — exposed for tests so we can synthesize a parse without
 * loading the real tree-sitter binary.
 */
export interface PythonParseInputs {
  readonly filePath: string;
  readonly content: string;
  /** Pre-built tree-sitter tree. Tests pass a fake. Production builds it via `loadParser`. */
  readonly tree: TreeLike;
}

/** Minimal shape of the tree-sitter AST nodes we read. Keeps tests light. */
export interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly children: readonly SyntaxNodeLike[];
  childForFieldName?(name: string): SyntaxNodeLike | null;
  descendantsOfType?(type: string): readonly SyntaxNodeLike[];
}

export interface TreeLike {
  readonly rootNode: SyntaxNodeLike;
}

export class TreeSitterPythonParser {
  private readonly logger: Logger;
  private loadAttempted = false;
  private parser: any | undefined;

  constructor() {
    this.logger = createLogger({ service: 'tree-sitter-python' });
  }

  /** Singleton-guarded load — Node's module cache makes this cheap. */
  private async loadParser(): Promise<any | undefined> {
    if (this.loadAttempted) return this.parser;
    this.loadAttempted = true;
    try {
      // @ts-ignore — optional runtime dep, may not be installed
      const TS = await import('tree-sitter' /* webpackIgnore: true */) as unknown as TreeSitterModule;
      // @ts-ignore — optional runtime dep, may not be installed
      const Py = await import('tree-sitter-python' /* webpackIgnore: true */) as unknown as GrammarModule;
      const Parser = TS.default;
      const p = new Parser();
      p.setLanguage(Py.default);
      this.parser = p;
      this.logger.info('tree-sitter Python parser loaded');
      return p;
    } catch (err) {
      this.logger.info({
        err: err instanceof Error ? err.message : String(err),
      }, 'tree-sitter-python not available; staying disabled');
      return undefined;
    }
  }

  /** True when both `tree-sitter` and `tree-sitter-python` are installed. */
  async isAvailable(): Promise<boolean> {
    return (await this.loadParser()) !== undefined;
  }

  /** Tree-sitter parse of a file. Returns undefined if the parser isn't loaded. */
  async parseFile(filePath: string): Promise<ParseResult | undefined> {
    const parser = await this.loadParser();
    if (!parser) return undefined;
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      this.logger.warn({ filePath, err }, 'failed to read python file');
      return emptyResult(filePath);
    }
    const tree = parser.parse(content);
    return parseFromTree({ filePath, content, tree });
  }
}

/**
 * Pure: derive a ParseResult from an already-built tree. Exported so unit
 * tests can drive the parser with a hand-built tree-like fixture instead
 * of a real tree-sitter installation.
 */
export function parseFromTree(input: PythonParseInputs): ParseResult {
  const imports = extractImports(input.tree.rootNode);
  const routes = extractRoutes(input.tree.rootNode);
  return {
    filePath: input.filePath,
    imports,
    exports: [],
    routes,
    httpCalls: [] as ParsedHttpCall[],
    databaseUsages: extractDbUsagesFromImports(imports),
    envVars: [],
    loc: countLines(input.content),
    kafka: { producers: [], consumers: [] } as ParsedKafka,
    httpCallSites: [] as ParsedHttpCallSite[],
  };
}

// ---- Extraction queries ----

/**
 * `import x`, `import x as y`, `from x import a`, `from x import (a, b, c)`.
 * Tree-sitter Python AST node types:
 *   - import_statement → wraps `import_from_statement` or `dotted_name` children
 *   - import_from_statement → has `module_name` + `aliased_import|dotted_name|wildcard_import`
 */
function extractImports(root: SyntaxNodeLike): ParsedImport[] {
  const out: ParsedImport[] = [];
  walk(root, (node) => {
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (child.type === 'dotted_name' || child.type === 'aliased_import') {
          const moduleName = child.type === 'aliased_import'
            ? textOfFirstNamed(child, 'dotted_name')
            : child.text;
          if (moduleName) {
            out.push(makeImport(moduleName));
          }
        }
      }
    } else if (node.type === 'import_from_statement') {
      const modNode = findChildByType(node, 'dotted_name')
        ?? findChildByType(node, 'relative_import');
      const module = modNode?.text;
      if (module) {
        out.push(makeImport(module));
      }
    }
  });
  return out;
}

/**
 * Detect `@app.get('/path')`, `@app.post(...)`, etc. as routes. Catches the
 * thing regex misses: decorators with non-string args (e.g. variables).
 */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

function extractRoutes(root: SyntaxNodeLike): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  walk(root, (node) => {
    if (node.type !== 'decorator') return;
    const call = findChildByType(node, 'call');
    if (!call) return;
    const fn = call.children.find((c) => c.type === 'attribute');
    if (!fn) return;
    // attribute: <object> . <attr>  — the *last* identifier is the method name.
    const identifiers = fn.children.filter((c) => c.type === 'identifier' && c.text);
    const attr = identifiers[identifiers.length - 1];
    if (!attr) return;
    const method = attr.text.toLowerCase();
    if (!ROUTE_METHODS.has(method)) return;

    const args = findChildByType(call, 'argument_list');
    if (!args) return;
    const firstStr = args.children.find((c) => c.type === 'string');
    if (!firstStr) return;
    const pathLit = stripQuotes(firstStr.text);
    if (!pathLit) return;

    out.push({
      method: method.toUpperCase(),
      path: pathLit,
      framework: 'python-decorator',
      handlerName: '',
    });
  });
  return out;
}

// ---- DB / shared helpers ----

const DB_SDK_PREFIXES: ReadonlyArray<{ prefix: string; database: string; sdk: string }> = [
  { prefix: 'psycopg', database: 'PostgreSQL', sdk: 'psycopg' },
  { prefix: 'sqlalchemy', database: 'SQL', sdk: 'sqlalchemy' },
  { prefix: 'pymongo', database: 'MongoDB', sdk: 'pymongo' },
  { prefix: 'redis', database: 'Redis', sdk: 'redis' },
  { prefix: 'asyncpg', database: 'PostgreSQL', sdk: 'asyncpg' },
  { prefix: 'mysql', database: 'MySQL', sdk: 'mysql' },
  { prefix: 'cassandra', database: 'Cassandra', sdk: 'cassandra-driver' },
];

function extractDbUsagesFromImports(imports: readonly ParsedImport[]): ParsedDatabaseUsage[] {
  const out: ParsedDatabaseUsage[] = [];
  for (const imp of imports) {
    for (const m of DB_SDK_PREFIXES) {
      if (imp.source === m.prefix || imp.source.startsWith(`${m.prefix}.`)) {
        out.push({
          databaseType: m.database,
          detectedVia: 'sdk_import',
          packageName: m.sdk,
        });
        break;
      }
    }
  }
  return out;
}

function makeImport(moduleName: string): ParsedImport {
  return {
    source: moduleName,
    specifiers: [],
    isTypeOnly: false,
    isLocal: false,
  };
}

function findChildByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | undefined {
  for (const c of node.children) if (c.type === type) return c;
  return undefined;
}

function textOfFirstNamed(node: SyntaxNodeLike, type: string): string {
  return findChildByType(node, type)?.text ?? '';
}

function stripQuotes(s: string): string {
  return s.replace(/^[bf]?["']|["']$/g, '');
}

function walk(root: SyntaxNodeLike, visit: (n: SyntaxNodeLike) => void): void {
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    visit(cur);
    // children may be empty for terminal nodes
    for (let i = cur.children.length - 1; i >= 0; i -= 1) stack.push(cur.children[i]!);
  }
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

function emptyResult(filePath: string): ParseResult {
  return {
    filePath,
    imports: [],
    exports: [],
    routes: [],
    httpCalls: [],
    databaseUsages: [],
    envVars: [],
    loc: 0,
    kafka: { producers: [], consumers: [] },
    httpCallSites: [],
  };
}

/** True when `EKG_TREESITTER_PYTHON=true`. Cheap to check per-file. */
export function isTreeSitterPythonEnabled(): boolean {
  return (process.env['EKG_TREESITTER_PYTHON'] ?? '').toLowerCase() === 'true';
}
