/**
 * Extraction pipeline — orchestrates the full extraction flow.
 *
 * scan files → parse each (TS or multi-lang) → extract relationships → graph-ready data.
 *
 * This is the core IP of the system.
 */

import { extname, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createLogger, DOC_EXTENSIONS } from '@ekg/shared';
import {
  FileScanner,
  ConfigScanner,
  ApiSchemaScanner,
  MetadataScanner,
  TypeScriptParserPool,
  MultiLanguageParser,
} from '@ekg/parser';
import type { CodeOwnerRule } from '@ekg/parser';
import type {
  GraphNode, GraphRelationship, ExtractionResult, EkgConfig, Logger,
  ParseResult, ParsedHttpCallSite, EdgeConfidence,
} from '@ekg/shared';
import { ImportExtractor } from './import.extractor.js';
import { ServiceDetector } from './service.detector.js';
import { MarkdownExtractor } from './markdown.extractor.js';
import { SchemaPrismaExtractor } from './schema.prisma.extractor.js';
import { OpenApiExtractor } from './openapi.extractor.js';
import { SymbolsExtractor } from './symbols.extractor.js';
import { HelmValuesExtractor } from './helm.values.extractor.js';
import { K8sManifestExtractor } from './k8s.manifest.extractor.js';
import { DotenvExtractor } from './dotenv.extractor.js';
import { CiVarsExtractor } from './ci.vars.extractor.js';
import { AppConfigExtractor } from './app.config.extractor.js';
import type { ConfigKeyNode, SecretRefNode } from '@ekg/shared';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class ExtractionPipeline {
  private readonly fileScanner: FileScanner;
  private readonly configScanner: ConfigScanner;
  private readonly schemaScanner: ApiSchemaScanner;
  private readonly metadataScanner: MetadataScanner;
  private readonly tsPool: TypeScriptParserPool;
  private readonly multiParser: MultiLanguageParser;
  private readonly importExtractor: ImportExtractor;
  private readonly serviceDetector: ServiceDetector;
  private readonly markdownExtractor: MarkdownExtractor;
  private readonly prismaExtractor: SchemaPrismaExtractor;
  private readonly openApiExtractor: OpenApiExtractor;
  private readonly symbolsExtractor: SymbolsExtractor;
  private readonly helmExtractor: HelmValuesExtractor;
  private readonly k8sExtractor: K8sManifestExtractor;
  private readonly dotenvExtractor: DotenvExtractor;
  private readonly ciVarsExtractor: CiVarsExtractor;
  private readonly appConfigExtractor: AppConfigExtractor;
  private readonly logger: Logger;

  constructor() {
    this.fileScanner = new FileScanner();
    this.configScanner = new ConfigScanner();
    this.schemaScanner = new ApiSchemaScanner();
    this.metadataScanner = new MetadataScanner();
    this.tsPool = new TypeScriptParserPool();
    this.multiParser = new MultiLanguageParser();
    this.importExtractor = new ImportExtractor();
    this.serviceDetector = new ServiceDetector();
    this.markdownExtractor = new MarkdownExtractor();
    this.prismaExtractor = new SchemaPrismaExtractor();
    this.openApiExtractor = new OpenApiExtractor();
    this.symbolsExtractor = new SymbolsExtractor();
    this.helmExtractor = new HelmValuesExtractor();
    this.k8sExtractor = new K8sManifestExtractor();
    this.dotenvExtractor = new DotenvExtractor();
    this.ciVarsExtractor = new CiVarsExtractor();
    this.appConfigExtractor = new AppConfigExtractor();
    this.logger = createLogger({ service: 'extraction-pipeline' });
  }

  async extract(
    repoDir: string,
    repoUrl: string,
    config?: Partial<EkgConfig>,
    serviceMappings?: Readonly<Record<string, string>>,
  ): Promise<ExtractionResult> {
    this.logger.info({ repoDir, repoUrl }, 'Starting extraction pipeline');

    const allNodes: GraphNode[] = [];
    const allRelationships: GraphRelationship[] = [];
    const allHttpCallSites: import('@ekg/shared').ExtractedHttpCallSite[] = [];

    // Step 0: Repo metadata (CODEOWNERS + latest commit)
    const metadata = await this.metadataScanner.scan(repoDir);

    // Step 1: Detect services
    const services = await this.serviceDetector.detect(repoDir, repoUrl, serviceMappings);
    const serviceNodes = this.serviceDetector.toGraphNodes(services, repoUrl);
    allNodes.push(...serviceNodes);

    // Repo node — now enriched with latest commit metadata
    allNodes.push({
      id: `repo:${repoUrl}`,
      label: 'Repo',
      name: this.extractRepoName(repoUrl),
      properties: {
        url: repoUrl,
        branch: 'main',
        lastCommitSha: metadata.latestCommitSha ?? '',
        lastCommitAt: metadata.latestCommitAt ?? '',
      },
    });

    // Step 1b: Owners / Teams from CODEOWNERS
    this.emitOwnerNodes(allNodes, allRelationships, services, metadata.codeOwners);

    // CONTAINS: Repo → Service
    for (const svc of serviceNodes) {
      allRelationships.push({
        type: 'CONTAINS',
        sourceId: `repo:${repoUrl}`,
        targetId: svc.id,
        confidence: 'HIGH',
        properties: {},
      });
    }

    // Pre-sort services by directory length (longest first) for prefix matching
    const servicesByDirLen = [...services].sort((a, b) => b.directory.length - a.directory.length);

    // Step 2: Scan files
    const files = await this.fileScanner.scan(repoDir, {
      ignoreDirs: config?.ignoreDirs as string[] | undefined,
      supportedExtensions: config?.supportedExtensions as string[] | undefined,
    });
    this.logger.info({ fileCount: files.length }, 'Files scanned');

    // Step 3: Parse files in bounded-parallel batches
    const concurrency = 8;
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const parsed = await Promise.all(batch.map(async (file) => {
        const ext = extname(file.absolutePath).toLowerCase();
        if (basename(file.absolutePath) === 'schema.prisma') {
          return { kind: 'prisma' as const, ext };
        }
        if (DOC_EXTENSIONS.has(ext)) {
          return { kind: 'doc' as const, ext };
        }
        if (TS_EXTENSIONS.has(ext)) {
          const r = await this.tsPool.parseFile(file.absolutePath);
          return r ? { kind: 'code' as const, result: r } : undefined;
        }
        if (MultiLanguageParser.handles(ext)) {
          const r = await this.multiParser.parseFile(file.absolutePath);
          return r ? { kind: 'code' as const, result: r } : undefined;
        }
        return undefined;
      }));

      for (let j = 0; j < parsed.length; j++) {
        const entry = parsed[j];
        const file = batch[j]!;
        if (!entry) continue;

        if (entry.kind === 'doc') {
          await this.handleDocFile(
            file,
            repoUrl,
            servicesByDirLen,
            allNodes,
            allRelationships,
          );
          continue;
        }

        if (entry.kind === 'prisma') {
          await this.handlePrismaFile(
            file,
            repoUrl,
            servicesByDirLen,
            allNodes,
            allRelationships,
          );
          continue;
        }

        const result = entry.result;
        const extraction = this.importExtractor.extract(result, repoUrl);

        // Enrich File nodes with size, LOC, repo + per-file last-changed metadata
        for (const node of extraction.nodes) {
          if (node.label !== 'File') continue;
          const props = node.properties as Record<string, unknown>;
          props['sizeBytes'] = file.sizeBytes;
          if (typeof result.loc === 'number') props['loc'] = result.loc;
          if (metadata.latestCommitAt) props['repoLastCommitAt'] = metadata.latestCommitAt;
          const fileLastChanged = metadata.fileLastChangedAt.get(file.relativePath);
          if (fileLastChanged) props['lastChangedAt'] = fileLastChanged;
        }

        allNodes.push(...extraction.nodes);
        allRelationships.push(...extraction.relationships);

        // Phase 1.5 follow-ups — Kafka producers/consumers + HTTP call sites.
        const matchingSvc = this.findServiceForFile(file.relativePath, servicesByDirLen);
        if (matchingSvc && result.kafka) {
          this.emitKafkaEdges(result, matchingSvc.name, repoUrl, allNodes, allRelationships);
        }
        if (result.httpCallSites && result.httpCallSites.length > 0) {
          for (const site of result.httpCallSites) {
            allHttpCallSites.push({
              url: site.url,
              method: site.method,
              clientLibrary: site.clientLibrary,
              sourceLine: site.sourceLine,
              filePath: result.filePath,
              isTemplate: site.isTemplate,
              ...(site.callerSymbolId ? { callerSymbolId: `${repoUrl}:${site.callerSymbolId}` } : {}),
            });
          }
        }

        // Symbol-level extraction (Phase 1.3) — TS/JS only. The parser only
        // populates `symbols` for files it owns; multi-language parsers leave
        // it undefined, so this is a no-op for everyone else.
        if (result.symbols) {
          const fileNode = extraction.nodes.find((n) => n.label === 'File');
          const language = (fileNode?.properties as { language?: string } | undefined)?.language ?? 'unknown';
          const symResult = this.symbolsExtractor.extract(
            result.symbols,
            repoUrl,
            result.filePath,
            language,
          );
          allNodes.push(...symResult.nodes);
          allRelationships.push(...symResult.relationships);
        }

        const matchingService = this.findServiceForFile(file.relativePath, servicesByDirLen);
        if (matchingService) {
          allRelationships.push({
            type: 'CONTAINS',
            sourceId: `service:${matchingService.name}`,
            targetId: `${repoUrl}:${file.absolutePath}`,
            confidence: 'HIGH',
            properties: {},
          });
        }

        // CODEOWNERS → Owner OWNS File
        const owners = MetadataScanner.resolveOwners(file.relativePath, metadata.codeOwners);
        for (const owner of owners) {
          allRelationships.push({
            type: 'OWNS',
            sourceId: this.ownerNodeId(owner),
            targetId: `${repoUrl}:${file.absolutePath}`,
            confidence: 'HIGH',
            properties: { source: 'CODEOWNERS' },
          });
        }
      }
    }

    // Step 3.5: API schema files (OpenAPI / proto / GraphQL)
    const schemaResults = await this.schemaScanner.scan(repoDir);
    const handledSpecPaths = new Set<string>();
    for (const sch of schemaResults) {
      // Resolve which service owns this schema by directory prefix
      const relPath = sch.filePath.startsWith(repoDir) ? sch.filePath.slice(repoDir.length + 1) : sch.filePath;

      // OpenAPI files get a richer extraction (operationId, schemas, tags, etc.)
      // via OpenApiExtractor — falling back to the scanner's basic routes if
      // the deep extractor produces nothing.
      if (sch.framework === 'openapi') {
        const enriched = await this.handleOpenApiSpec(
          sch.filePath,
          relPath,
          repoUrl,
          servicesByDirLen,
          allNodes,
          allRelationships,
        );
        handledSpecPaths.add(sch.filePath);
        if (enriched > 0) continue;
      }

      const owningService = this.findServiceForFile(relPath, servicesByDirLen);
      for (const route of sch.routes) {
        const apiId = `api:${route.method}:${route.path}`;
        allNodes.push({
          id: apiId,
          label: 'API',
          name: `${route.method} ${route.path}`,
          properties: {
            method: route.method,
            path: route.path,
            framework: route.framework,
            schemaFile: relPath,
          },
        });
        if (owningService) {
          allRelationships.push({
            type: 'EXPOSES',
            sourceId: `service:${owningService.name}`,
            targetId: apiId,
            confidence: 'HIGH',
            properties: { source: 'schema', schemaFile: relPath },
          });
        }
      }
    }

    // Step 3.6: Content-sniff JSON/YAML files for OpenAPI/Swagger specs that
    // the filename-based scanner missed. Bounded to the file list we already
    // walked — no extra disk traversal.
    await this.sniffOpenApiSpecs(
      files,
      repoDir,
      repoUrl,
      servicesByDirLen,
      handledSpecPaths,
      allNodes,
      allRelationships,
    );

    // Step 3.7: Phase 1.6 — config & secret extraction across Helm,
    // K8s manifests, dotenv templates, CI workflows, and app configs.
    await this.extractConfigsAndSecrets(
      files,
      repoUrl,
      servicesByDirLen,
      allNodes,
      allRelationships,
    );

    // Step 4: Config files for additional DB references
    const configResults = await this.configScanner.scan(repoDir);
    for (const configResult of configResults) {
      for (const dbUsage of configResult.databaseUsages) {
        const dbId = `db:${dbUsage.databaseType.toLowerCase()}`;
        allNodes.push({
          id: dbId,
          label: 'Database',
          name: dbUsage.databaseType,
          properties: { type: dbUsage.databaseType, detectedVia: dbUsage.detectedVia },
        });
      }
    }

    // Step 5: Service-level rollup (optimised: O(N) via Maps)
    this.inferServiceRelationships(allNodes, allRelationships, services, repoUrl);

    // Deduplicate
    const uniqueNodes = this.deduplicateNodes(allNodes);
    const uniqueRels = this.deduplicateRelationships(allRelationships);

    this.logger.info({
      nodes: uniqueNodes.length,
      relationships: uniqueRels.length,
      services: services.length,
      files: files.length,
    }, 'Extraction pipeline completed');

    return {
      nodes: uniqueNodes,
      relationships: uniqueRels,
      sourceFile: repoDir,
      repoUrl,
      httpCallSites: allHttpCallSites,
    };
  }

  /**
   * Emit `Topic` nodes (id `topic:<name>`, shared across services for
   * cross-repo linking) plus `Service -[PRODUCES|CONSUMES]-> Topic` edges.
   * Idempotent; the pipeline-level dedupe collapses repeats.
   */
  private emitKafkaEdges(
    result: ParseResult,
    serviceName: string,
    repoUrl: string,
    nodes: GraphNode[],
    relationships: GraphRelationship[],
  ): void {
    const kafka = result.kafka;
    if (!kafka) return;
    const serviceId = `service:${serviceName}`;
    const seen = new Set<string>();
    const emit = (refs: readonly { name: string; template?: string; sourceLine: number; confidence: 'HIGH' | 'MEDIUM' }[], type: 'PRODUCES' | 'CONSUMES'): void => {
      for (const ref of refs) {
        const topicId = `topic:${ref.name}`;
        nodes.push({
          id: topicId,
          label: 'Topic',
          name: ref.name,
          properties: {
            name: ref.name,
            ...(ref.template ? { template: ref.template } : {}),
          },
        });
        const dedupKey = `${type}|${serviceId}|${topicId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const conf: EdgeConfidence = ref.confidence;
        relationships.push({
          type,
          sourceId: serviceId,
          targetId: topicId,
          confidence: conf,
          properties: {
            sourceFile: result.filePath,
            sourceLine: ref.sourceLine,
          },
        });
      }
    };
    emit(kafka.producers, 'PRODUCES');
    emit(kafka.consumers, 'CONSUMES');
  }

  /**
   * O(N) service-level rollup: index file nodes once, then bucket relationships
   * by which service directory the file lives in.
   */
  private inferServiceRelationships(
    nodes: readonly GraphNode[],
    relationships: GraphRelationship[],
    services: readonly { name: string; directory: string }[],
    _repoUrl: string,
  ): void {
    // Index file nodes by id
    const fileById = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (n.label === 'File') fileById.set(n.id, n);
    }

    // Pre-sort services for longest-prefix matching
    const sortedServices = [...services].sort((a, b) => b.directory.length - a.directory.length);

    const serviceDbs = new Map<string, Set<string>>();
    const serviceApis = new Map<string, Set<string>>();

    for (const rel of relationships) {
      if (rel.type !== 'USES' && rel.type !== 'EXPOSES') continue;
      const fileNode = fileById.get(rel.sourceId);
      if (!fileNode) continue;
      const filePath = (fileNode.properties as { path?: string }).path ?? '';
      let svcName: string | undefined;
      for (const svc of sortedServices) {
        if (filePath.startsWith(svc.directory)) { svcName = svc.name; break; }
      }
      if (!svcName) continue;

      const key = `service:${svcName}`;
      const map = rel.type === 'USES' ? serviceDbs : serviceApis;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(rel.targetId);
    }

    for (const [serviceId, dbIds] of serviceDbs) {
      for (const dbId of dbIds) {
        relationships.push({
          type: 'USES',
          sourceId: serviceId,
          targetId: dbId,
          confidence: 'HIGH',
          properties: { inferred: true },
        });
      }
    }
    for (const [serviceId, apiIds] of serviceApis) {
      for (const apiId of apiIds) {
        relationships.push({
          type: 'EXPOSES',
          sourceId: serviceId,
          targetId: apiId,
          confidence: 'HIGH',
          properties: { inferred: true },
        });
      }
    }
  }

  private findServiceForFile(
    relativePath: string,
    servicesSortedByDirLen: readonly { name: string; directory: string }[],
  ): { name: string; directory: string } | undefined {
    for (const svc of servicesSortedByDirLen) {
      if (relativePath.startsWith(svc.directory)) return svc;
    }
    return servicesSortedByDirLen[servicesSortedByDirLen.length - 1];
  }

  private deduplicateNodes(nodes: readonly GraphNode[]): readonly GraphNode[] {
    const seen = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (!seen.has(node.id)) seen.set(node.id, node);
    }
    return [...seen.values()];
  }

  private deduplicateRelationships(rels: readonly GraphRelationship[]): readonly GraphRelationship[] {
    const seen = new Map<string, GraphRelationship>();
    for (const rel of rels) {
      const key = `${rel.type}|${rel.sourceId}|${rel.targetId}`;
      if (!seen.has(key)) seen.set(key, rel);
    }
    return [...seen.values()];
  }

  /**
   * Read a doc file from disk, run MarkdownExtractor, and emit Doc nodes
   * plus Repo→Doc (CONTAINS) and Service→Doc (DOCUMENTED_BY) edges.
   */
  private async handleDocFile(
    file: { absolutePath: string; relativePath: string },
    repoUrl: string,
    servicesByDirLen: readonly { name: string; directory: string }[],
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): Promise<void> {
    let content: string;
    try {
      content = await readFile(file.absolutePath, 'utf8');
    } catch (err) {
      this.logger.warn(
        { err, path: file.relativePath },
        'Failed to read doc file; skipping',
      );
      return;
    }

    const { doc } = this.markdownExtractor.extract(content, file.relativePath, repoUrl);
    allNodes.push(doc);

    allRelationships.push({
      type: 'CONTAINS',
      sourceId: `repo:${repoUrl}`,
      targetId: doc.id,
      confidence: 'HIGH',
      properties: { source: 'doc-extractor' },
    });

    const matchingService = this.findServiceForFile(file.relativePath, servicesByDirLen);
    if (matchingService) {
      allRelationships.push({
        type: 'DOCUMENTED_BY',
        sourceId: `service:${matchingService.name}`,
        targetId: doc.id,
        confidence: 'HIGH',
        properties: { source: 'doc-extractor' },
      });
    }
  }

  /**
   * Read a `schema.prisma` file, run SchemaPrismaExtractor, and emit
   * Table + Column nodes plus File→Table (CONTAINS), Table→Column (HAS),
   * Table→Table (RELATES_TO), and Service→Table (OWNS) edges.
   */
  private async handlePrismaFile(
    file: { absolutePath: string; relativePath: string },
    repoUrl: string,
    servicesByDirLen: readonly { name: string; directory: string }[],
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): Promise<void> {
    let content: string;
    try {
      content = await readFile(file.absolutePath, 'utf8');
    } catch (err) {
      this.logger.warn(
        { err, path: file.relativePath },
        'Failed to read prisma schema; skipping',
      );
      return;
    }

    const result = this.prismaExtractor.extract(content, file.relativePath, repoUrl);
    if (result.tables.length === 0) return;

    // Emit a File node for the schema so File→Table (CONTAINS) has a source.
    const fileId = `${repoUrl}:${file.absolutePath}`;
    allNodes.push({
      id: fileId,
      label: 'File',
      name: file.relativePath,
      properties: {
        path: file.relativePath,
        language: 'prisma',
        hash: '',
        repoUrl,
      },
    });

    allNodes.push(...result.tables);
    allNodes.push(...result.columns);
    allRelationships.push(...result.relations);

    const owningService = this.findServiceForFile(file.relativePath, servicesByDirLen);
    for (const table of result.tables) {
      allRelationships.push({
        type: 'CONTAINS',
        sourceId: fileId,
        targetId: table.id,
        confidence: 'HIGH',
        properties: { source: 'prisma-extractor' },
      });
      if (owningService) {
        allRelationships.push({
          type: 'OWNS',
          sourceId: `service:${owningService.name}`,
          targetId: table.id,
          confidence: 'HIGH',
          properties: { source: 'prisma-extractor' },
        });
      }
    }
  }

  /**
   * Read an OpenAPI/Swagger spec, run OpenApiExtractor, emit rich API nodes
   * plus Service -[EXPOSES]-> API edges. Returns the number of API nodes
   * produced (0 ⇒ caller should fall back to the basic scanner output).
   */
  private async handleOpenApiSpec(
    absolutePath: string,
    relativePath: string,
    repoUrl: string,
    servicesByDirLen: readonly { name: string; directory: string }[],
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): Promise<number> {
    let content: string;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch (err) {
      this.logger.warn(
        { err, path: relativePath },
        'Failed to read OpenAPI spec; skipping',
      );
      return 0;
    }

    const { apis } = this.openApiExtractor.extract(content, relativePath, repoUrl);
    if (apis.length === 0) return 0;

    const owningService = this.findServiceForFile(relativePath, servicesByDirLen);
    for (const api of apis) {
      allNodes.push(api);
      if (owningService) {
        allRelationships.push({
          type: 'EXPOSES',
          sourceId: `service:${owningService.name}`,
          targetId: api.id,
          confidence: 'HIGH',
          properties: { source: 'openapi-extractor', specPath: relativePath },
        });
      }
    }
    return apis.length;
  }

  /**
   * Walk the already-scanned file list and content-sniff any `.json/.yaml/.yml`
   * file whose filename didn't match the OpenAPI/Swagger naming convention.
   * Skips files already handled by `handleOpenApiSpec`.
   */
  private async sniffOpenApiSpecs(
    files: readonly { absolutePath: string; relativePath: string }[],
    _repoDir: string,
    repoUrl: string,
    servicesByDirLen: readonly { name: string; directory: string }[],
    handledAbsPaths: ReadonlySet<string>,
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): Promise<void> {
    for (const file of files) {
      if (handledAbsPaths.has(file.absolutePath)) continue;
      if (!OpenApiExtractor.isSniffable(file.relativePath)) continue;
      // If the filename already routed via the scanner, skip — we either
      // already handled it or it's not a spec.
      if (OpenApiExtractor.handlesByPath(file.relativePath)) continue;

      let content: string;
      try {
        content = await readFile(file.absolutePath, 'utf8');
      } catch {
        continue;
      }
      const sniffed = OpenApiExtractor.sniff(content);
      if (!sniffed) continue;

      await this.handleOpenApiSpec(
        file.absolutePath,
        file.relativePath,
        repoUrl,
        servicesByDirLen,
        allNodes,
        allRelationships,
      );
    }
  }

  /**
   * Phase 1.6 — route every scanned file through the appropriate config /
   * secret extractor and emit ConfigKey / SecretRef nodes plus
   * Service-[READS_CONFIG|USES_SECRET]-> edges.
   *
   * Order matters: more specific path-based detectors run first (Helm, K8s,
   * CI, app config), and dotenv templates are matched by basename. Files
   * that match nothing fall through to the existing pipeline.
   */
  private async extractConfigsAndSecrets(
    files: readonly { absolutePath: string; relativePath: string }[],
    repoUrl: string,
    servicesByDirLen: readonly { name: string; directory: string }[],
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): Promise<void> {
    for (const file of files) {
      const route = this.routeConfigFile(file.relativePath);
      if (!route) continue;
      let content: string;
      try {
        content = await readFile(file.absolutePath, 'utf8');
      } catch (err) {
        this.logger.warn({ err, path: file.relativePath }, 'Failed to read config file');
        continue;
      }
      const result = this.runConfigExtractor(route, content, file.relativePath, repoUrl);
      if (result.configKeys.length === 0 && result.secretRefs.length === 0) continue;

      const owningService = this.findServiceForFile(file.relativePath, servicesByDirLen);
      this.emitConfigNodes(result, owningService?.name, allNodes, allRelationships);
    }
  }

  private routeConfigFile(relativePath: string):
    | 'helm' | 'k8s' | 'dotenv' | 'ci' | 'app' | undefined {
    if (DotenvExtractor.handlesByPath(relativePath)) return 'dotenv';
    if (CiVarsExtractor.handlesByPath(relativePath)) return 'ci';
    if (HelmValuesExtractor.handlesByPath(relativePath)) return 'helm';
    if (K8sManifestExtractor.handlesByPath(relativePath)) return 'k8s';
    if (AppConfigExtractor.handlesByPath(relativePath)) return 'app';
    return undefined;
  }

  private runConfigExtractor(
    route: 'helm' | 'k8s' | 'dotenv' | 'ci' | 'app',
    content: string,
    relativePath: string,
    repoUrl: string,
  ): { configKeys: readonly ConfigKeyNode[]; secretRefs: readonly SecretRefNode[] } {
    switch (route) {
      case 'helm': return this.helmExtractor.extract(content, relativePath, repoUrl);
      case 'k8s':  return this.k8sExtractor.extract(content, relativePath, repoUrl);
      case 'dotenv': {
        const r = this.dotenvExtractor.extract(content, relativePath, repoUrl);
        return { configKeys: r.configKeys, secretRefs: [] };
      }
      case 'ci':   return this.ciVarsExtractor.extract(content, relativePath, repoUrl);
      case 'app': {
        const r = this.appConfigExtractor.extract(content, relativePath, repoUrl);
        return { configKeys: r.configKeys, secretRefs: [] };
      }
    }
  }

  private emitConfigNodes(
    result: { configKeys: readonly ConfigKeyNode[]; secretRefs: readonly SecretRefNode[] },
    serviceName: string | undefined,
    allNodes: GraphNode[],
    allRelationships: GraphRelationship[],
  ): void {
    for (const ck of result.configKeys) {
      allNodes.push(ck);
      if (serviceName) {
        allRelationships.push({
          type: 'READS_CONFIG',
          sourceId: `service:${serviceName}`,
          targetId: ck.id,
          confidence: 'HIGH',
          properties: {
            kind: ck.properties.kind,
            sourceFile: ck.properties.filePath,
          },
        });
      }
    }
    for (const sr of result.secretRefs) {
      allNodes.push(sr);
      if (serviceName) {
        allRelationships.push({
          type: 'USES_SECRET',
          sourceId: `service:${serviceName}`,
          targetId: sr.id,
          confidence: 'HIGH',
          properties: {
            vendor: sr.properties.vendor,
            sourceFile: sr.properties.filePath,
          },
        });
      }
    }
  }

  private extractRepoName(repoUrl: string): string {
    const match = /\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
    return match?.[1] ?? 'unknown-repo';
  }

  /**
   * Build the per-owner node id. `@org/team` → Team; `@user` or `email@x` → Owner.
   */
  private ownerNodeId(owner: string): string {
    if (owner.startsWith('@') && owner.includes('/')) return `team:${owner.slice(1).toLowerCase()}`;
    return `owner:${owner.replace(/^@/, '').toLowerCase()}`;
  }

  /**
   * Emit Owner / Team nodes from CODEOWNERS rules and link team members
   * (org/team → owner) where derivable. Service-level OWNS edges are added
   * for any service whose directory matches a rule pattern that's a prefix.
   */
  private emitOwnerNodes(
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    services: readonly { name: string; directory: string }[],
    rules: readonly CodeOwnerRule[],
  ): void {
    const seenOwners = new Set<string>();
    for (const rule of rules) {
      for (const owner of rule.owners) {
        const id = this.ownerNodeId(owner);
        if (seenOwners.has(id)) continue;
        seenOwners.add(id);

        if (id.startsWith('team:')) {
          nodes.push({
            id,
            label: 'Team',
            name: owner,
            properties: { handle: owner },
          });
        } else {
          nodes.push({
            id,
            label: 'Owner',
            name: owner,
            properties: { handle: owner },
          });
        }
      }
    }

    // Service-level OWNS — match any rule pattern whose path prefix matches the service directory
    for (const rule of rules) {
      const pat = rule.pattern.replace(/^\/+/, '');
      if (!pat.endsWith('/')) continue;
      for (const svc of services) {
        const dir = svc.directory.replace(/^\/+/, '');
        if (dir.startsWith(pat) || pat.startsWith(dir + '/')) {
          for (const owner of rule.owners) {
            relationships.push({
              type: 'OWNS',
              sourceId: this.ownerNodeId(owner),
              targetId: `service:${svc.name}`,
              confidence: 'HIGH',
              properties: { source: 'CODEOWNERS', pattern: rule.pattern },
            });
          }
        }
      }
    }
  }
}
