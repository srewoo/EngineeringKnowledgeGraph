/**
 * API schema scanner — extracts API endpoints from declarative schema files:
 * - OpenAPI (Swagger): openapi.{yaml,yml,json}, swagger.{yaml,yml,json}
 * - gRPC: *.proto (rpc method definitions)
 * - GraphQL: *.graphql, *.gql (Query / Mutation / Subscription fields)
 *
 * Produces ParsedRoute records that downstream extractors lift into API nodes.
 *
 * YAML parsing is intentionally minimal — we don't need a full YAML AST,
 * just to find paths and method declarations. Trade-off: we may miss exotic
 * structures, but we never crash on malformed YAML.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { createLogger } from '@ekg/shared';
import type { Logger, ParsedRoute } from '@ekg/shared';

export interface ApiSchemaScanResult {
  readonly filePath: string;
  readonly framework: 'openapi' | 'grpc' | 'graphql';
  readonly routes: readonly ParsedRoute[];
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

export class ApiSchemaScanner {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'api-schema-scanner' });
  }

  /**
   * Walk a repo and scan every schema file we recognise.
   * Bounded by extension so we don't open large unrelated YAMLs.
   */
  async scan(repoDir: string): Promise<readonly ApiSchemaScanResult[]> {
    const results: ApiSchemaScanResult[] = [];
    await this.walk(repoDir, results, 0);
    this.logger.info({
      repoDir,
      schemasFound: results.length,
      totalRoutes: results.reduce((s, r) => s + r.routes.length, 0),
    }, 'API schema scan completed');
    return results;
  }

  private async walk(
    dir: string,
    results: ApiSchemaScanResult[],
    depth: number,
  ): Promise<void> {
    if (depth > 8) return; // safety cap
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);

      if (entry.isDirectory()) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'vendor' || name === 'dist' || name === 'build' || name === 'target') continue;
        await this.walk(full, results, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(name).toLowerCase();
      const lower = name.toLowerCase();
      if (ext === '.proto') {
        const r = await this.scanProto(full);
        if (r) results.push(r);
      } else if (ext === '.graphql' || ext === '.gql') {
        const r = await this.scanGraphql(full);
        if (r) results.push(r);
      } else if ((ext === '.yaml' || ext === '.yml' || ext === '.json')
                 && (lower.includes('openapi') || lower.includes('swagger'))) {
        const r = await this.scanOpenapi(full);
        if (r) results.push(r);
      }
    }
  }

  // -- OpenAPI ---------------------------------------------------------------

  private async scanOpenapi(filePath: string): Promise<ApiSchemaScanResult | undefined> {
    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { return undefined; }

    // Very lightweight: walk the "paths:" section and collect path + method literals.
    // Works for the common 2-space-indented YAML / JSON used in 99% of OpenAPI specs.
    const routes: ParsedRoute[] = [];

    // JSON path
    if (filePath.toLowerCase().endsWith('.json')) {
      try {
        const obj = JSON.parse(content) as { paths?: Record<string, Record<string, unknown>> };
        for (const [path, methods] of Object.entries(obj.paths ?? {})) {
          for (const method of Object.keys(methods)) {
            if (!HTTP_METHODS.has(method.toLowerCase())) continue;
            routes.push({
              method: method.toUpperCase(),
              path,
              handlerName: 'openapi-spec',
              framework: 'openapi',
            });
          }
        }
        return { filePath, framework: 'openapi', routes };
      } catch {
        return undefined;
      }
    }

    // YAML path: regex-based block walker — find the indentation of `paths:` then
    // collect `  /xxx:` (route) and `    get:` (method) entries.
    const lines = content.split('\n');
    let inPaths = false;
    let pathsIndent = -1;
    let currentPath: string | undefined;
    let currentPathIndent = -1;

    for (const raw of lines) {
      const line = raw.replace(/\t/g, '  ');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      if (!inPaths) {
        if (/^paths\s*:/.test(trimmed)) {
          inPaths = true;
          pathsIndent = indent;
        }
        continue;
      }

      // Exit paths block
      if (indent <= pathsIndent && trimmed && !trimmed.startsWith('#')) {
        inPaths = false;
        currentPath = undefined;
        continue;
      }

      // Path entry: "  /users/{id}:"
      const pathMatch = /^(\/[^:]*?)\s*:\s*$/.exec(trimmed);
      if (pathMatch && (currentPathIndent === -1 || indent <= currentPathIndent)) {
        currentPath = pathMatch[1];
        currentPathIndent = indent;
        continue;
      }

      // Method entry: "    get:"
      const methodMatch = /^([a-z]+)\s*:/.exec(trimmed);
      if (currentPath && methodMatch && HTTP_METHODS.has(methodMatch[1]!.toLowerCase()) && indent > currentPathIndent) {
        routes.push({
          method: methodMatch[1]!.toUpperCase(),
          path: currentPath,
          handlerName: 'openapi-spec',
          framework: 'openapi',
        });
      }
    }

    return { filePath, framework: 'openapi', routes };
  }

  // -- gRPC ------------------------------------------------------------------

  private async scanProto(filePath: string): Promise<ApiSchemaScanResult | undefined> {
    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { return undefined; }
    const routes: ParsedRoute[] = [];

    // service Foo { rpc DoThing(Req) returns (Resp); }
    const re = /service\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceName = m[1]!;
      const body = m[2]!;
      const rpcRe = /rpc\s+(\w+)\s*\(/g;
      let rpc: RegExpExecArray | null;
      while ((rpc = rpcRe.exec(body)) !== null) {
        const rpcName = rpc[1]!;
        routes.push({
          method: 'GRPC',
          path: `/${serviceName}/${rpcName}`,
          handlerName: rpcName,
          framework: 'grpc',
        });
      }
    }

    return { filePath, framework: 'grpc', routes };
  }

  // -- GraphQL ---------------------------------------------------------------

  private async scanGraphql(filePath: string): Promise<ApiSchemaScanResult | undefined> {
    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { return undefined; }
    const routes: ParsedRoute[] = [];

    // Find Query / Mutation / Subscription type bodies and collect top-level field names.
    const typeRe = /\b(?:type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;
    let m: RegExpExecArray | null;
    while ((m = typeRe.exec(content)) !== null) {
      const typeName = m[1]!;
      const body = m[2]!;
      const fieldRe = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:/gm;
      let f: RegExpExecArray | null;
      while ((f = fieldRe.exec(body)) !== null) {
        const fieldName = f[1]!;
        routes.push({
          method: typeName.toUpperCase(),
          path: `/graphql/${fieldName}`,
          handlerName: fieldName,
          framework: 'graphql',
        });
      }
    }

    return { filePath, framework: 'graphql', routes };
  }
}
