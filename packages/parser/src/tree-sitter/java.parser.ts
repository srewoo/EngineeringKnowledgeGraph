/**
 * Tree-sitter Java parser (Phase A rollout).
 *
 * Same shape as Python/Go pilots — pure `parseFromTree` + dynamic-import
 * native binding, self-disables if deps not installed.
 *
 * Closes accuracy gaps over the regex tier on:
 *   - Annotations spanning multiple lines (`@RequestMapping(\n  value = "..."`)
 *   - Spring `@GetMapping` / `@PostMapping` / `@RequestMapping(method = ...)`
 *   - JAX-RS `@Path("...")` + method-level `@GET` / `@POST`
 *   - Generic-laden DB SDK imports (`org.springframework.data.jpa.*`)
 *   - Static imports (`import static org.junit...`)
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

export interface JavaParseInputs {
  readonly filePath: string;
  readonly content: string;
  readonly tree: TreeLike;
}

export class TreeSitterJavaParser {
  private readonly logger: Logger;
  private loadAttempted = false;
  private parser: any | undefined;

  constructor() {
    this.logger = createLogger({ service: 'tree-sitter-java' });
  }

  private async loadParser(): Promise<any | undefined> {
    if (this.loadAttempted) return this.parser;
    this.loadAttempted = true;
    try {
      // @ts-ignore optional dep
      const TS = await import('tree-sitter' /* webpackIgnore: true */) as unknown as TreeSitterModule;
      // @ts-ignore optional dep
      const Java = await import('tree-sitter-java' /* webpackIgnore: true */) as unknown as GrammarModule;
      const Parser = TS.default;
      const p = new Parser();
      p.setLanguage(Java.default);
      this.parser = p;
      this.logger.info('tree-sitter Java parser loaded');
      return p;
    } catch (err) {
      this.logger.info({
        err: err instanceof Error ? err.message : String(err),
      }, 'tree-sitter-java not available; staying disabled');
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
      this.logger.warn({ filePath, err }, 'failed to read java file');
      return emptyResult(filePath);
    }
    const tree = parser.parse(content);
    return parseFromTree({ filePath, content, tree });
  }
}

/**
 * Pure: derive a ParseResult from a Java syntax tree.
 */
export function parseFromTree(input: JavaParseInputs): ParseResult {
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
 * Java imports — `import_declaration` whose child `scoped_identifier`
 * holds the fully-qualified name. `import static` flagged on the
 * declaration as a `static` child keyword.
 */
function extractImports(root: SyntaxNodeLike): ParsedImport[] {
  const out: ParsedImport[] = [];
  walk(root, (node) => {
    if (node.type !== 'import_declaration') return;
    const fqn = findChildByType(node, 'scoped_identifier');
    if (!fqn) return;
    const moduleName = fqn.text;
    if (!moduleName) return;
    const isStatic = node.children.some((c) => c.type === 'static');
    out.push({
      source: moduleName,
      specifiers: [],
      isTypeOnly: isStatic, // overload: stamp static imports so consumers can filter
      isLocal: false,
    });
  });
  return out;
}

/**
 * Routes — Spring + JAX-RS conventions. Three patterns we recognise:
 *
 *   1. `@RequestMapping(value = "/path", method = RequestMethod.GET)`
 *   2. `@GetMapping("/path")` / `@PostMapping("/path")` / ...
 *   3. `@Path("/path")` (class) + method-level `@GET` / `@POST` etc.
 *
 * The tree-sitter-java AST node for annotations is `marker_annotation`
 * (no args) or `annotation` (with `annotation_argument_list`). We scan
 * both.
 */
const SPRING_MAPPING_TO_METHOD: Readonly<Record<string, string>> = {
  GetMapping:    'GET',
  PostMapping:   'POST',
  PutMapping:    'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping:  'PATCH',
};

const JAXRS_MARKER_TO_METHOD: Readonly<Record<string, string>> = {
  GET: 'GET', POST: 'POST', PUT: 'PUT',
  DELETE: 'DELETE', PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS',
};

function extractRoutes(root: SyntaxNodeLike): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  walk(root, (node) => {
    if (node.type === 'annotation') {
      const name = findChildByType(node, 'identifier')?.text
        ?? findChildByType(node, 'scoped_identifier')?.text;
      if (!name) return;

      // @GetMapping("/path"), @PostMapping("/path"), etc.
      const springMethod = SPRING_MAPPING_TO_METHOD[name];
      if (springMethod) {
        const pathLit = extractAnnotationStringArg(node);
        if (pathLit) {
          out.push({ method: springMethod, path: pathLit, framework: 'spring', handlerName: '' });
        }
        return;
      }

      // @RequestMapping(value = "/path", method = RequestMethod.GET)
      if (name === 'RequestMapping') {
        const pathLit = extractAnnotationStringArg(node);
        const method  = extractRequestMappingMethod(node);
        if (pathLit) {
          out.push({ method: method ?? 'ANY', path: pathLit, framework: 'spring', handlerName: '' });
        }
        return;
      }

      // @Path("/x") — JAX-RS class-level or method-level
      if (name === 'Path') {
        const pathLit = extractAnnotationStringArg(node);
        if (pathLit) {
          out.push({ method: 'ANY', path: pathLit, framework: 'jaxrs', handlerName: '' });
        }
      }
    } else if (node.type === 'marker_annotation') {
      const name = findChildByType(node, 'identifier')?.text;
      if (!name) return;
      const jaxrsMethod = JAXRS_MARKER_TO_METHOD[name];
      if (jaxrsMethod) {
        // marker_annotation alone has no path; we emit a route with empty
        // path — the post-processor in `extractor` will join it with the
        // class-level @Path("/users") if present. For now, just record
        // the method-only marker.
        out.push({ method: jaxrsMethod, path: '', framework: 'jaxrs', handlerName: '' });
      }
    }
  });
  return out;
}

/** Pull the first string literal from an annotation_argument_list. */
function extractAnnotationStringArg(annotation: SyntaxNodeLike): string {
  const args = findChildByType(annotation, 'annotation_argument_list');
  if (!args) return '';
  for (const child of args.children) {
    if (child.type === 'string_literal') return stripQuotes(child.text);
    if (child.type === 'element_value_pair') {
      const lit = findChildByType(child, 'string_literal');
      if (lit) return stripQuotes(lit.text);
    }
  }
  return '';
}

/** Read `method = RequestMethod.X` from a @RequestMapping. */
function extractRequestMappingMethod(annotation: SyntaxNodeLike): string | undefined {
  const args = findChildByType(annotation, 'annotation_argument_list');
  if (!args) return undefined;
  for (const child of args.children) {
    if (child.type !== 'element_value_pair') continue;
    const key = findChildByType(child, 'identifier');
    if (key?.text !== 'method') continue;
    // method = RequestMethod.GET → field_access ending in GET
    const access = findChildByType(child, 'field_access');
    if (!access) continue;
    const last = access.children.filter((c) => c.type === 'identifier').pop();
    if (last) return last.text;
  }
  return undefined;
}

const JAVA_DB_SDK_PREFIXES: ReadonlyArray<{ prefix: string; database: string; sdk: string }> = [
  { prefix: 'org.springframework.data.jpa',        database: 'SQL',         sdk: 'spring-data-jpa' },
  { prefix: 'org.springframework.data.mongodb',    database: 'MongoDB',     sdk: 'spring-data-mongodb' },
  { prefix: 'org.springframework.data.redis',      database: 'Redis',       sdk: 'spring-data-redis' },
  { prefix: 'org.springframework.data.cassandra',  database: 'Cassandra',   sdk: 'spring-data-cassandra' },
  { prefix: 'javax.persistence',                   database: 'SQL',         sdk: 'jpa' },
  { prefix: 'jakarta.persistence',                 database: 'SQL',         sdk: 'jpa' },
  { prefix: 'org.hibernate',                       database: 'SQL',         sdk: 'hibernate' },
  { prefix: 'org.mongodb',                         database: 'MongoDB',     sdk: 'mongodb-driver' },
  { prefix: 'redis.clients.jedis',                 database: 'Redis',       sdk: 'jedis' },
  { prefix: 'com.datastax.oss.driver',             database: 'Cassandra',   sdk: 'cassandra-java-driver' },
  { prefix: 'com.mysql.cj.jdbc',                   database: 'MySQL',       sdk: 'mysql-connector-j' },
  { prefix: 'org.postgresql',                      database: 'PostgreSQL',  sdk: 'postgresql' },
];

function extractDbUsagesFromImports(imports: readonly ParsedImport[]): ParsedDatabaseUsage[] {
  const out: ParsedDatabaseUsage[] = [];
  for (const imp of imports) {
    for (const m of JAVA_DB_SDK_PREFIXES) {
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

function findChildByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | undefined {
  for (const c of node.children) if (c.type === type) return c;
  return undefined;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
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

/** True when `EKG_TREESITTER_JAVA=true`. */
export function isTreeSitterJavaEnabled(): boolean {
  return (process.env['EKG_TREESITTER_JAVA'] ?? '').toLowerCase() === 'true';
}
