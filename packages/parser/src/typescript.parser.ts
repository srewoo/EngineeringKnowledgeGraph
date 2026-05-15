/**
 * TypeScript/JavaScript parser using ts-morph.
 *
 * Extracts structural facts from source files:
 * - Import statements (local vs npm, type-only)
 * - Export declarations (functions, classes, variables, types)
 * - API route registrations (Express, Fastify, Koa)
 * - HTTP client calls (axios, fetch, got)
 * - Database SDK usage (couchbase, mongoose, pg, redis)
 * - Environment variable references (process.env.*)
 *
 * This is deterministic extraction — NO AI involved.
 */

import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { createLogger } from '@ekg/shared';
import { TypeScriptSymbolsParser } from './typescript.symbols.parser.js';
import { KafkaTypeScriptExtractor } from './kafka.ts.parser.js';
import { HttpClientTypeScriptExtractor } from './http.client.ts.parser.js';
import {
  DATABASE_SDK_MAP,
  HTTP_CLIENT_PACKAGES,
  API_FRAMEWORK_PACKAGES,
} from '@ekg/shared';
import type {
  ParseResult,
  ParsedImport,
  ParsedExport,
  ParsedRoute,
  ParsedHttpCall,
  ParsedDatabaseUsage,
  ParsedKafka,
  ParsedHttpCallSite,
  Logger,
} from '@ekg/shared';

export class TypeScriptParser {
  private readonly project: Project;
  private readonly logger: Logger;
  private readonly symbolsParser: TypeScriptSymbolsParser;
  private readonly kafkaExtractor: KafkaTypeScriptExtractor;
  private readonly httpExtractor: HttpClientTypeScriptExtractor;

  constructor() {
    this.logger = createLogger({ service: 'typescript-parser' });
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
    this.symbolsParser = new TypeScriptSymbolsParser();
    this.kafkaExtractor = new KafkaTypeScriptExtractor();
    this.httpExtractor = new HttpClientTypeScriptExtractor();
  }

  /**
   * Parse a single file and extract all structural facts.
   */
  parseFile(filePath: string): ParseResult {
    let sourceFile: SourceFile;
    try {
      sourceFile = this.project.addSourceFileAtPath(filePath);
    } catch (error) {
      this.logger.warn({ filePath, error }, 'Failed to parse file');
      return this.emptyResult(filePath);
    }

    try {
      const imports = this.extractImports(sourceFile);
      const exports = this.extractExports(sourceFile);
      const routes = this.extractRoutes(sourceFile, imports);
      const httpCalls = this.extractHttpCalls(sourceFile, imports);
      const databaseUsages = this.extractDatabaseUsages(imports);
      const envVars = this.extractEnvVars(sourceFile);
      // Symbol-level extraction (Phase 1.3). Ids are scoped to filePath here;
      // the extractor re-prefixes with repoUrl when building graph nodes.
      const symbols = this.symbolsParser.extract(sourceFile, filePath, filePath, imports);
      // Phase 1.5 follow-ups — Kafka topics + line-tagged HTTP call sites.
      const kafka: ParsedKafka = this.kafkaExtractor.extract(sourceFile, imports);
      const httpCallSites: readonly ParsedHttpCallSite[] = this.httpExtractor.extract(sourceFile, imports, filePath);

      this.logger.debug({
        filePath,
        imports: imports.length,
        exports: exports.length,
        routes: routes.length,
        httpCalls: httpCalls.length,
        dbUsages: databaseUsages.length,
        envVars: envVars.length,
        functions: symbols.functions.length,
        classes: symbols.classes.length,
        methods: symbols.methods.length,
        typeDefs: symbols.typeDefs.length,
        kafkaProducers: kafka.producers.length,
        kafkaConsumers: kafka.consumers.length,
        httpCallSites: httpCallSites.length,
      }, 'File parsed successfully');

      const loc = sourceFile.getFullText().split('\n').length;
      return {
        filePath, imports, exports, routes, httpCalls, databaseUsages, envVars, loc, symbols,
        kafka, httpCallSites,
      };
    } finally {
      this.project.removeSourceFile(sourceFile);
    }
  }

  /**
   * Parse multiple files and return all results.
   */
  parseFiles(filePaths: readonly string[]): readonly ParseResult[] {
    return filePaths.map((fp) => this.parseFile(fp));
  }

  // -- Import Extraction --

  private extractImports(source: SourceFile): readonly ParsedImport[] {
    const results: ParsedImport[] = [];

    // ES module imports: import { x } from 'y'
    for (const decl of source.getImportDeclarations()) {
      const moduleSpecifier = decl.getModuleSpecifierValue();
      const isTypeOnly = decl.isTypeOnly();
      const isLocal = moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/');

      const specifiers: string[] = [];

      const defaultImport = decl.getDefaultImport();
      if (defaultImport) {
        specifiers.push(defaultImport.getText());
      }

      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport) {
        specifiers.push(`* as ${namespaceImport.getText()}`);
      }

      for (const named of decl.getNamedImports()) {
        specifiers.push(named.getName());
      }

      results.push({
        source: moduleSpecifier,
        specifiers,
        isTypeOnly,
        isLocal,
      });
    }

    // CommonJS require: const x = require('y')
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getText() !== 'require') continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      const firstArg = args[0];
      if (!firstArg || firstArg.getKind() !== SyntaxKind.StringLiteral) continue;

      const moduleSpecifier = firstArg.getText().replace(/['"]/g, '');
      const isLocal = moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/');

      results.push({
        source: moduleSpecifier,
        specifiers: [],
        isTypeOnly: false,
        isLocal,
      });
    }

    return results;
  }

  // -- Export Extraction --

  private extractExports(source: SourceFile): readonly ParsedExport[] {
    const results: ParsedExport[] = [];

    for (const fn of source.getFunctions()) {
      if (fn.isExported()) {
        results.push({
          name: fn.getName() ?? 'anonymous',
          kind: 'function',
          isTypeOnly: false,
        });
      }
    }

    for (const cls of source.getClasses()) {
      if (cls.isExported()) {
        results.push({
          name: cls.getName() ?? 'anonymous',
          kind: 'class',
          isTypeOnly: false,
        });
      }
    }

    for (const varStmt of source.getVariableStatements()) {
      if (varStmt.isExported()) {
        for (const decl of varStmt.getDeclarations()) {
          results.push({
            name: decl.getName(),
            kind: 'variable',
            isTypeOnly: false,
          });
        }
      }
    }

    for (const iface of source.getInterfaces()) {
      if (iface.isExported()) {
        results.push({
          name: iface.getName(),
          kind: 'interface',
          isTypeOnly: true,
        });
      }
    }

    for (const typeAlias of source.getTypeAliases()) {
      if (typeAlias.isExported()) {
        results.push({
          name: typeAlias.getName(),
          kind: 'type',
          isTypeOnly: true,
        });
      }
    }

    for (const enumDecl of source.getEnums()) {
      if (enumDecl.isExported()) {
        results.push({
          name: enumDecl.getName(),
          kind: 'enum',
          isTypeOnly: false,
        });
      }
    }

    // Default export
    const defaultExport = source.getDefaultExportSymbol();
    if (defaultExport) {
      results.push({
        name: defaultExport.getName(),
        kind: 'default',
        isTypeOnly: false,
      });
    }

    return results;
  }

  // -- Route Extraction --

  private extractRoutes(
    source: SourceFile,
    imports: readonly ParsedImport[],
  ): readonly ParsedRoute[] {
    const results: ParsedRoute[] = [];
    const hasFramework = imports.some((imp) =>
      API_FRAMEWORK_PACKAGES.includes(imp.source),
    );

    if (!hasFramework) return results;

    const framework = imports.find((imp) =>
      API_FRAMEWORK_PACKAGES.includes(imp.source),
    )?.source ?? 'unknown';

    // 1) NestJS / decorator-based controllers: @Controller('users') class { @Get(':id') ... }
    const isNest = imports.some((imp) => imp.source === '@nestjs/common');
    if (isNest) {
      results.push(...this.extractNestRoutes(source));
    }

    // 2) Express / Fastify / Koa style: app.get('/path', handler)
    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

      const methodName = expr.asKind(SyntaxKind.PropertyAccessExpression)
        ?.getName()
        ?.toLowerCase();

      if (!methodName || !httpMethods.has(methodName)) continue;

      const args = call.getArguments();
      if (args.length < 2) continue;

      const firstArg = args[0];
      if (!firstArg) continue;
      const path = this.extractUrlLiteral(firstArg);
      if (!path) continue;
      if (!path.startsWith('/') && !path.startsWith(':')) continue;

      results.push({
        method: methodName.toUpperCase(),
        path,
        handlerName: args.length > 1 ? args[args.length - 1]!.getText() : 'anonymous',
        framework,
      });
    }

    return results;
  }

  /**
   * Extract NestJS controller routes by composing the @Controller(prefix) path
   * with each method-level @Get/@Post/... decorator.
   */
  private extractNestRoutes(source: SourceFile): readonly ParsedRoute[] {
    const out: ParsedRoute[] = [];
    const HTTP_DECORATORS = new Set([
      'Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All', 'Sse',
    ]);

    for (const cls of source.getClasses()) {
      // Find @Controller('prefix') if present
      let prefix = '';
      for (const dec of cls.getDecorators()) {
        if (dec.getName() !== 'Controller') continue;
        const args = dec.getArguments();
        const first = args[0];
        if (!first) continue;
        const literal = this.extractUrlLiteral(first);
        if (literal !== undefined) prefix = literal;
        // @Controller({ path: 'x' })
        if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = first.asKind(SyntaxKind.ObjectLiteralExpression);
          const pathProp = obj?.getProperty('path');
          if (pathProp) {
            const initializer = pathProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
            if (initializer) {
              const v = this.extractUrlLiteral(initializer);
              if (v !== undefined) prefix = v;
            }
          }
        }
      }

      for (const method of cls.getMethods()) {
        for (const dec of method.getDecorators()) {
          const decName = dec.getName();
          if (!HTTP_DECORATORS.has(decName)) continue;
          const args = dec.getArguments();
          let methodPath = '';
          if (args[0]) {
            const v = this.extractUrlLiteral(args[0]);
            if (v !== undefined) methodPath = v;
          }
          const fullPath = this.joinPaths(prefix, methodPath);
          out.push({
            method: decName.toUpperCase(),
            path: fullPath,
            handlerName: `${cls.getName() ?? 'AnonController'}.${method.getName()}`,
            framework: '@nestjs/common',
          });
        }
      }
    }

    return out;
  }

  private joinPaths(prefix: string, suffix: string): string {
    const p = prefix.replace(/^\/+|\/+$/g, '');
    const s = suffix.replace(/^\/+|\/+$/g, '');
    if (!p && !s) return '/';
    if (!s) return `/${p}`;
    if (!p) return `/${s}`;
    return `/${p}/${s}`;
  }

  // -- HTTP Call Extraction --

  private extractHttpCalls(
    source: SourceFile,
    imports: readonly ParsedImport[],
  ): readonly ParsedHttpCall[] {
    const results: ParsedHttpCall[] = [];
    const httpImports = imports.filter((imp) =>
      HTTP_CLIENT_PACKAGES.includes(imp.source),
    );

    if (httpImports.length === 0) return results;

    // Build whitelist of identifiers bound to HTTP clients (default + named imports).
    const clientIdentifiers = new Set<string>();
    for (const imp of httpImports) {
      for (const spec of imp.specifiers) clientIdentifiers.add(spec.replace(/^\*\s+as\s+/, ''));
      // axios → identifier "axios"
      const tail = imp.source.split('/').pop() ?? imp.source;
      clientIdentifiers.add(tail);
    }
    // Always allow global fetch when node-fetch / undici / global fetch is in scope
    if (httpImports.some((i) => ['node-fetch', 'undici'].includes(i.source))) {
      clientIdentifiers.add('fetch');
    }

    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      let receiver: string | undefined;
      let method = 'GET';
      let isCall = false;

      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const prop = expr.asKind(SyntaxKind.PropertyAccessExpression);
        const propName = prop?.getName()?.toLowerCase();
        const recvText = prop?.getExpression().getText() ?? '';
        if (propName && httpMethods.has(propName) && this.matchesClientIdentifier(recvText, clientIdentifiers)) {
          receiver = recvText;
          method = propName.toUpperCase();
          isCall = true;
        }
      } else if (expr.getKind() === SyntaxKind.Identifier) {
        const name = expr.getText();
        if (clientIdentifiers.has(name) && (name === 'fetch' || name === 'axios')) {
          receiver = name;
          isCall = true;
        }
      }

      if (!isCall) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;
      const firstArg = args[0];
      if (!firstArg) continue;

      const url = this.extractUrlLiteral(firstArg);
      if (!url) continue;
      // Accept absolute URLs, leading-slash paths, or template literals starting with a placeholder
      const looksLikeUrl = url.startsWith('http') || url.startsWith('/') || url.startsWith('{var}');
      if (!looksLikeUrl) continue;

      const clientLib = httpImports.find((h) =>
        receiver !== undefined && (h.source === receiver || (h.source.split('/').pop() ?? '') === receiver),
      )?.source ?? httpImports[0]?.source ?? 'unknown';

      results.push({ url, method, clientLibrary: clientLib });
    }

    return results;
  }

  private matchesClientIdentifier(receiver: string, ids: ReadonlySet<string>): boolean {
    if (!receiver) return false;
    if (ids.has(receiver)) return true;
    // axios.create() → variable holds an instance; allow any chain that begins with a known id
    const head = receiver.split(/[.\(\[]/)[0] ?? '';
    return ids.has(head);
  }

  private extractUrlLiteral(node: { getKind: () => number; getText: () => string }): string | undefined {
    const kind = node.getKind();
    if (kind === SyntaxKind.StringLiteral) {
      return node.getText().slice(1, -1);
    }
    if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return node.getText().slice(1, -1);
    }
    if (kind === SyntaxKind.TemplateExpression) {
      // Replace ${...} with placeholder so we still capture the route shape
      const raw = node.getText().slice(1, -1);
      return raw.replace(/\$\{[^}]*\}/g, '{var}');
    }
    return undefined;
  }

  // -- Database Usage Extraction --

  private extractDatabaseUsages(
    imports: readonly ParsedImport[],
  ): readonly ParsedDatabaseUsage[] {
    const results: ParsedDatabaseUsage[] = [];

    for (const imp of imports) {
      if (imp.isTypeOnly) continue;

      const dbType = DATABASE_SDK_MAP[imp.source];
      if (dbType) {
        results.push({
          databaseType: dbType,
          detectedVia: 'sdk_import',
          packageName: imp.source,
        });
      }
    }

    return results;
  }

  // -- Environment Variable Extraction --

  private extractEnvVars(source: SourceFile): readonly string[] {
    const envVars = new Set<string>();

    // Match process.env.VARIABLE_NAME patterns
    for (const access of source.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const text = access.getText();
      const match = /^process\.env\.(\w+)$/.exec(text);
      if (match?.[1]) {
        envVars.add(match[1]);
      }
    }

    // Match process.env['VARIABLE_NAME'] patterns
    for (const access of source.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
      const text = access.getText();
      const match = /^process\.env\[['"](\w+)['"]\]$/.exec(text);
      if (match?.[1]) {
        envVars.add(match[1]);
      }
    }

    return [...envVars];
  }

  private emptyResult(filePath: string): ParseResult {
    return {
      filePath,
      imports: [],
      exports: [],
      routes: [],
      httpCalls: [],
      databaseUsages: [],
      envVars: [],
    };
  }
}
