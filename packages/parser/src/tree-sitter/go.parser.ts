/**
 * Tree-sitter Go parser (Phase A rollout).
 *
 * Same shape as the Python pilot — pure `parseFromTree` over a `TreeLike`
 * fixture for testability; production uses dynamic-imported tree-sitter
 * native binding. Self-disables if `tree-sitter` / `tree-sitter-go` aren't
 * installed; the regex parser remains the fallback.
 *
 * Closes accuracy gaps over the regex tier on:
 *   - Multi-line import blocks (`import (\n  "a"\n  "b"\n)`)
 *   - Aliased imports (`a "fmt"`)
 *   - Blank imports for side effects (`_ "github.com/lib/pq"`)
 *   - http.Handle("/...") and gin.GET("/...") routes (gorilla-mux / gin /
 *     chi conventions caught with explicit matchers, not regex on the line)
 */

import { readFile } from 'node:fs/promises';
import { createLogger, type Logger } from '@ekg/shared';
import type {
  ParseResult, ParsedImport, ParsedRoute, ParsedHttpCall,
  ParsedDatabaseUsage, ParsedKafka, ParsedHttpCallSite,
} from '@ekg/shared';
import type { SyntaxNodeLike, TreeLike } from './python.parser.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TreeSitterModule = { default: new () => any };
type GrammarModule = { default: unknown };

export interface GoParseInputs {
  readonly filePath: string;
  readonly content: string;
  readonly tree: TreeLike;
}

export class TreeSitterGoParser {
  private readonly logger: Logger;
  private loadAttempted = false;
  private parser: any | undefined;

  constructor() {
    this.logger = createLogger({ service: 'tree-sitter-go' });
  }

  private async loadParser(): Promise<any | undefined> {
    if (this.loadAttempted) return this.parser;
    this.loadAttempted = true;
    try {
      // @ts-ignore — optional runtime dep, may not be installed
      const TS = await import('tree-sitter' /* webpackIgnore: true */) as unknown as TreeSitterModule;
      // @ts-ignore — optional runtime dep, may not be installed
      const Go = await import('tree-sitter-go' /* webpackIgnore: true */) as unknown as GrammarModule;
      const Parser = TS.default;
      const p = new Parser();
      p.setLanguage(Go.default);
      this.parser = p;
      this.logger.info('tree-sitter Go parser loaded');
      return p;
    } catch (err) {
      this.logger.info({
        err: err instanceof Error ? err.message : String(err),
      }, 'tree-sitter-go not available; staying disabled');
      return undefined;
    }
  }

  async isAvailable(): Promise<boolean> { return (await this.loadParser()) !== undefined; }

  async parseFile(filePath: string): Promise<ParseResult | undefined> {
    const parser = await this.loadParser();
    if (!parser) return undefined;
    let content: string;
    try { content = await readFile(filePath, 'utf-8'); }
    catch (err) {
      this.logger.warn({ filePath, err }, 'failed to read go file');
      return emptyResult(filePath);
    }
    const tree = parser.parse(content);
    return parseFromTree({ filePath, content, tree });
  }
}

/**
 * Pure: derive a ParseResult from a Go syntax tree. Exported for tests so
 * they can drive the parser without installing the native binding.
 */
export function parseFromTree(input: GoParseInputs): ParseResult {
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

/**
 * Go import shapes (tree-sitter-go grammar):
 *   import_declaration
 *     import_spec_list
 *       import_spec { path: interpreted_string_literal, [name: package_identifier|blank_identifier] }
 *   import_declaration
 *     import_spec { path: ... }
 */
function extractImports(root: SyntaxNodeLike): ParsedImport[] {
  const out: ParsedImport[] = [];
  walk(root, (node) => {
    if (node.type !== 'import_declaration') return;
    const list = findChildByType(node, 'import_spec_list');
    if (list) {
      for (const spec of list.children) {
        if (spec.type === 'import_spec') pushSpec(spec, out);
      }
    } else {
      const spec = findChildByType(node, 'import_spec');
      if (spec) pushSpec(spec, out);
    }
  });
  return out;
}

function pushSpec(spec: SyntaxNodeLike, out: ParsedImport[]): void {
  const path = findChildByType(spec, 'interpreted_string_literal')
    ?? findChildByType(spec, 'raw_string_literal');
  if (!path) return;
  const moduleName = stripQuotes(path.text);
  if (!moduleName) return;
  out.push({
    source: moduleName,
    specifiers: [],
    isTypeOnly: false,
    isLocal: !moduleName.includes('/') || moduleName.startsWith('./') || moduleName.startsWith('../'),
  });
}

/**
 * Routes — Go has no decorator pattern; we look for call_expressions whose
 * function is an attribute access ending in an HTTP method and whose first
 * arg is a string literal.
 *
 * Matches: `r.GET("/path", handler)`, `mux.HandleFunc("/path", h)`,
 *          `app.POST("/path", h)`, `http.Handle("/path", h)`.
 */
const GO_ROUTE_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', // gin / echo / chi
  'Handle', 'HandleFunc',                                      // net/http
]);

function extractRoutes(root: SyntaxNodeLike): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.children.find((c) => c.type === 'selector_expression');
    if (!fn) return;
    // selector_expression: <expr> . <field_identifier>
    const field = fn.children.find((c) => c.type === 'field_identifier');
    if (!field || !GO_ROUTE_METHODS.has(field.text)) return;
    const args = findChildByType(node, 'argument_list');
    if (!args) return;
    const firstStr = args.children.find(
      (c) => c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal',
    );
    if (!firstStr) return;
    const pathLit = stripQuotes(firstStr.text);
    if (!pathLit) return;
    const httpMethod = field.text === 'Handle' || field.text === 'HandleFunc'
      ? 'ANY'
      : field.text;
    out.push({
      method: httpMethod,
      path: pathLit,
      framework: 'go-router',
      handlerName: '',
    });
  });
  return out;
}

const GO_DB_SDK_PREFIXES: ReadonlyArray<{ prefix: string; database: string; sdk: string }> = [
  { prefix: 'github.com/lib/pq',             database: 'PostgreSQL', sdk: 'pq' },
  { prefix: 'github.com/jackc/pgx',          database: 'PostgreSQL', sdk: 'pgx' },
  { prefix: 'gorm.io/gorm',                  database: 'SQL',         sdk: 'gorm' },
  { prefix: 'github.com/jmoiron/sqlx',       database: 'SQL',         sdk: 'sqlx' },
  { prefix: 'go.mongodb.org/mongo-driver',   database: 'MongoDB',     sdk: 'mongo-driver' },
  { prefix: 'github.com/redis/go-redis',     database: 'Redis',       sdk: 'go-redis' },
  { prefix: 'github.com/go-sql-driver/mysql', database: 'MySQL',      sdk: 'go-sql-driver/mysql' },
];

function extractDbUsagesFromImports(imports: readonly ParsedImport[]): ParsedDatabaseUsage[] {
  const out: ParsedDatabaseUsage[] = [];
  for (const imp of imports) {
    for (const m of GO_DB_SDK_PREFIXES) {
      if (imp.source === m.prefix || imp.source.startsWith(`${m.prefix}/`)) {
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

function findChildByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | undefined {
  for (const c of node.children) if (c.type === type) return c;
  return undefined;
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, '');
}

function walk(root: SyntaxNodeLike, visit: (n: SyntaxNodeLike) => void): void {
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    visit(cur);
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
    filePath, imports: [], exports: [], routes: [], httpCalls: [],
    databaseUsages: [], envVars: [], loc: 0,
    kafka: { producers: [], consumers: [] }, httpCallSites: [],
  };
}

/** True when `EKG_TREESITTER_GO=true`. */
export function isTreeSitterGoEnabled(): boolean {
  return (process.env['EKG_TREESITTER_GO'] ?? '').toLowerCase() === 'true';
}
