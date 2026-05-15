/**
 * Ingestion service — orchestrates smart ingestion pipeline.
 *
 * Flow: clone/pull → check SHA → full or incremental extract → batched graph write.
 *
 * Smart behaviour:
 * - First run: full extraction
 * - Same SHA as before: skip entirely (no work needed)
 * - Different SHA: incremental (re-parse only changed files)
 *
 * Performance:
 * - Parses files in bounded-parallel batches (CPU-bound regex / ts-morph)
 * - Batches Neo4j writes via UNWIND (see GraphRepository)
 * - Scopes orphan cleanup to the affected repo only
 */

import { createLogger, metrics } from '@ekg/shared';
import type { Logger, IngestionJob, ParseResult } from '@ekg/shared';
import { SqliteRepository, RepoStateRepository } from '@ekg/storage';
import { GraphRepository } from '@ekg/graph';
import { Neo4jClient } from '@ekg/graph';
import { ExtractionPipeline } from '@ekg/extractor';
import { TypeScriptParserPool, MultiLanguageParser } from '@ekg/parser';
import { ImportExtractor } from '@ekg/extractor';
import { RepoCloner } from './repo.cloner.js';
import { EmbeddingsService } from './embeddings.service.js';
import { SearchIndexService } from './search-index.service.js';
import { UrlApiLinker } from './url.api.linker.js';
import type { UnresolvedHttpRepository } from '@ekg/storage';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { DEFAULT_SUPPORTED_EXTENSIONS, BINARY_AND_LIBRARY_EXTENSIONS, MAX_SOURCE_FILE_BYTES } from '@ekg/shared';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PARSE_CONCURRENCY = 8;

export interface IngestionOptions {
  readonly repoUrl: string;
  readonly branch: string;
  readonly token?: string;
  readonly serviceMappings?: Readonly<Record<string, string>>;
  /** Optional abort signal — cancels a stuck clone/pull. */
  readonly signal?: AbortSignal;
}

export interface CloneOnlyResult {
  readonly repoUrl: string;
  readonly branch: string;
  readonly localPath: string;
  readonly currentSha: string;
  readonly previousSha?: string;
  readonly isNewClone: boolean;
  readonly changedFiles: readonly string[];
  readonly skipped: boolean;
  readonly jobId: string;
}

export class IngestionService {
  private readonly cloner: RepoCloner;
  private readonly pipeline: ExtractionPipeline;
  private readonly tsPool: TypeScriptParserPool;
  private readonly multiParser: MultiLanguageParser;
  private readonly extractor: ImportExtractor;
  private readonly graphRepo: GraphRepository;
  private readonly sqliteRepo: SqliteRepository;
  private readonly repoStateRepo: RepoStateRepository;
  private readonly embeddingsService?: EmbeddingsService;
  private readonly searchIndexService?: SearchIndexService;
  private readonly urlApiLinker: UrlApiLinker;
  private readonly logger: Logger;

  constructor(
    dataDir: string,
    neo4jClient: Neo4jClient,
    sqliteRepo: SqliteRepository,
    embeddingsService?: EmbeddingsService,
    searchIndexService?: SearchIndexService,
    unresolvedHttpRepo?: UnresolvedHttpRepository,
  ) {
    this.cloner = new RepoCloner(dataDir);
    this.pipeline = new ExtractionPipeline();
    this.tsPool = new TypeScriptParserPool();
    this.multiParser = new MultiLanguageParser();
    this.extractor = new ImportExtractor();
    this.graphRepo = new GraphRepository(neo4jClient);
    this.sqliteRepo = sqliteRepo;
    this.repoStateRepo = new RepoStateRepository(sqliteRepo.getConnection());
    this.embeddingsService = embeddingsService;
    this.searchIndexService = searchIndexService;
    this.urlApiLinker = new UrlApiLinker(neo4jClient, unresolvedHttpRepo);
    this.logger = createLogger({ service: 'ingestion-service' });
  }

  async ingest(options: IngestionOptions): Promise<IngestionJob> {
    const job = this.sqliteRepo.createJob(options.repoUrl, options.branch);
    this.logger.info({ jobId: job.id, repoUrl: options.repoUrl }, 'Ingestion started');
    const startedAt = Date.now();

    try {
      this.sqliteRepo.updateJobStatus(job.id, 'CLONING');
      const previousSha = this.sqliteRepo.getLastCommitSha(options.repoUrl);

      const cloneResult = await this.cloner.cloneOrPull(
        options.repoUrl,
        options.branch,
        options.token,
        previousSha,
        options.signal,
      );

      this.logger.info({
        jobId: job.id,
        sha: cloneResult.currentSha,
        previousSha,
        isNew: cloneResult.isNewClone,
        changedFiles: cloneResult.changedFiles.length,
      }, 'Repository cloned/pulled');

      if (!cloneResult.isNewClone && previousSha === cloneResult.currentSha) {
        this.logger.info({ jobId: job.id }, 'No changes — skipping');
        this.sqliteRepo.updateJobStatus(job.id, 'COMPLETED', {
          commitSha: cloneResult.currentSha,
          filesProcessed: 0,
          nodesCreated: 0,
          edgesCreated: 0,
        });
        return this.sqliteRepo.getJobById(job.id) ?? job;
      }

      const supportedExts = new Set(DEFAULT_SUPPORTED_EXTENSIONS);
      const changedSourceFiles = cloneResult.changedFiles.filter((f) => {
        const ext = extname(f).toLowerCase();
        return supportedExts.has(ext) && !BINARY_AND_LIBRARY_EXTENSIONS.has(ext);
      });

      const shouldDoFull = cloneResult.isNewClone
        || !previousSha
        || changedSourceFiles.length > 100;

      if (shouldDoFull) {
        return this.runFullExtraction(job.id, cloneResult.localPath, cloneResult.currentSha, options);
      }

      return this.runIncrementalExtraction(
        job.id,
        cloneResult.localPath,
        cloneResult.currentSha,
        changedSourceFiles,
        options,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sqliteRepo.updateJobStatus(job.id, 'FAILED', { error: errorMessage });
      this.recordRepoState(options.repoUrl, undefined, errorMessage);
      this.logger.error({ jobId: job.id, error: errorMessage }, 'Ingestion failed');
      metrics.inc('ingest.failed');
      metrics.observe('ingest.duration_ms', Date.now() - startedAt, { status: 'FAILED' });
      return this.sqliteRepo.getJobById(job.id) ?? { ...job, status: 'FAILED', error: errorMessage };
    } finally {
      const final = this.sqliteRepo.getJobById(job.id);
      if (final?.status === 'COMPLETED') {
        metrics.inc('ingest.success');
        metrics.observe('ingest.duration_ms', Date.now() - startedAt, { status: 'COMPLETED' });
        metrics.inc('ingest.files_processed', final.filesProcessed);
        this.recordRepoState(options.repoUrl, final.commitSha, undefined);
      }
    }
  }

  private async runFullExtraction(
    jobId: string,
    localPath: string,
    currentSha: string,
    options: IngestionOptions,
  ): Promise<IngestionJob> {
    this.logger.info({ jobId }, 'Running FULL extraction');

    this.sqliteRepo.updateJobStatus(jobId, 'PARSING');
    const extraction = await this.pipeline.extract(
      localPath,
      options.repoUrl,
      undefined,
      options.serviceMappings,
    );

    this.sqliteRepo.updateJobStatus(jobId, 'BUILDING_GRAPH');
    const nodesCreated = await this.graphRepo.mergeNodes(extraction.nodes);
    let edgesCreated = await this.graphRepo.mergeRelationships(extraction.relationships);

    // Phase 1.5 — URL → API resolution (cross-service CALLS_API edges).
    // Best-effort: failures don't block ingest.
    try {
      if (extraction.httpCallSites && extraction.httpCallSites.length > 0) {
        const linked = await this.urlApiLinker.link({
          repoUrl: options.repoUrl,
          localPath,
          nodes: extraction.nodes,
          httpCallSites: extraction.httpCallSites,
        });
        if (linked.newRelationships.length > 0) {
          edgesCreated += await this.graphRepo.mergeRelationships(linked.newRelationships);
        }
      }
    } catch (err) {
      this.logger.warn({ err, jobId }, 'URL→API linker failed (continuing)');
    }

    // Best-effort BM25 indexing — always-on, local + free.
    if (this.searchIndexService) {
      await this.searchIndexService.indexFromExtraction(
        options.repoUrl,
        localPath,
        extraction.nodes,
        extraction.relationships,
      );
    }

    // Best-effort embeddings — never fails the ingest.
    if (this.embeddingsService?.enabled) {
      await this.embeddingsService.embedFromExtraction(
        options.repoUrl,
        localPath,
        extraction.nodes,
        extraction.relationships,
      );
    }

    this.sqliteRepo.updateJobStatus(jobId, 'COMPLETED', {
      commitSha: currentSha,
      filesProcessed: extraction.nodes.filter((n) => n.label === 'File').length,
      nodesCreated,
      edgesCreated,
    });

    this.logger.info({ jobId, nodesCreated, edgesCreated }, 'Full extraction completed');
    return this.sqliteRepo.getJobById(jobId)!;
  }

  private async runIncrementalExtraction(
    jobId: string,
    localPath: string,
    currentSha: string,
    changedFiles: readonly string[],
    options: IngestionOptions,
  ): Promise<IngestionJob> {
    this.logger.info({ jobId, changedFileCount: changedFiles.length }, 'Running INCREMENTAL extraction');

    // Batch-delete stale graph data and metadata
    this.sqliteRepo.updateJobStatus(jobId, 'BUILDING_GRAPH');
    await this.graphRepo.deleteBySourceFiles(changedFiles, options.repoUrl);
    for (const f of changedFiles) {
      this.sqliteRepo.deleteFileMetadata(f, options.repoUrl);
    }

    // Re-parse changed files in bounded-parallel batches
    this.sqliteRepo.updateJobStatus(jobId, 'PARSING');
    const allNodes = [];
    const allRels = [];
    const fileMetaUpdates: { path: string; hash: string; language: string }[] = [];

    for (let i = 0; i < changedFiles.length; i += PARSE_CONCURRENCY) {
      const batch = changedFiles.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (file) => {
        const absolutePath = join(localPath, file);
        const ext = extname(file).toLowerCase();

        // Size guard: skip checked-in bundles even if they ended up in the diff
        try {
          const st = await stat(absolutePath);
          if (st.size > MAX_SOURCE_FILE_BYTES) return undefined;
        } catch {
          return undefined;
        }

        let parseResult: ParseResult | undefined;
        if (TS_EXTENSIONS.has(ext)) {
          parseResult = await this.tsPool.parseFile(absolutePath);
        } else if (MultiLanguageParser.handles(ext)) {
          parseResult = await this.multiParser.parseFile(absolutePath);
        }
        if (!parseResult) return undefined;

        const extraction = this.extractor.extract(parseResult, options.repoUrl);
        const hash = await this.computeFileHash(absolutePath);
        return {
          file,
          extraction,
          hash,
          language: this.detectLanguage(file),
        };
      }));

      for (const r of results) {
        if (!r) continue;
        allNodes.push(...r.extraction.nodes);
        allRels.push(...r.extraction.relationships);
        fileMetaUpdates.push({ path: r.file, hash: r.hash, language: r.language });
      }
    }

    const nodesCreated = await this.graphRepo.mergeNodes(allNodes);
    const edgesCreated = await this.graphRepo.mergeRelationships(allRels);

    for (const m of fileMetaUpdates) {
      this.sqliteRepo.upsertFileMetadata({
        path: m.path,
        repoUrl: options.repoUrl,
        hash: m.hash,
        language: m.language,
        lastParsedAt: new Date().toISOString(),
      });
    }

    // Repo-scoped orphan cleanup (no full-graph scan)
    await this.graphRepo.cleanupOrphans(options.repoUrl);

    // Best-effort BM25 indexing on the freshly re-parsed nodes only.
    if (this.searchIndexService) {
      await this.searchIndexService.indexFromExtraction(
        options.repoUrl,
        localPath,
        allNodes,
        allRels,
      );
    }

    // Best-effort embeddings on the freshly re-parsed nodes only.
    if (this.embeddingsService?.enabled) {
      await this.embeddingsService.embedFromExtraction(
        options.repoUrl,
        localPath,
        allNodes,
        allRels,
      );
    }

    this.sqliteRepo.updateJobStatus(jobId, 'COMPLETED', {
      commitSha: currentSha,
      filesProcessed: changedFiles.length,
      nodesCreated,
      edgesCreated,
    });

    this.logger.info({
      jobId,
      filesProcessed: changedFiles.length,
      nodesCreated,
      edgesCreated,
    }, 'Incremental extraction completed');

    return this.sqliteRepo.getJobById(jobId)!;
  }

  /** Phase 1 of the two-phase pipeline: clone/pull only, no graph writes. */
  async cloneOnly(options: IngestionOptions): Promise<CloneOnlyResult> {
    const job = this.sqliteRepo.createJob(options.repoUrl, options.branch);
    this.sqliteRepo.updateJobStatus(job.id, 'CLONING');
    const previousSha = this.sqliteRepo.getLastCommitSha(options.repoUrl);

    const cloneResult = await this.cloner.cloneOrPull(
      options.repoUrl,
      options.branch,
      options.token,
      previousSha,
      options.signal,
    );

    const skipped = !cloneResult.isNewClone && previousSha === cloneResult.currentSha;
    if (skipped) {
      this.sqliteRepo.updateJobStatus(job.id, 'COMPLETED', {
        commitSha: cloneResult.currentSha,
        filesProcessed: 0,
        nodesCreated: 0,
        edgesCreated: 0,
      });
    }

    return {
      repoUrl: options.repoUrl,
      branch: options.branch,
      localPath: cloneResult.localPath,
      currentSha: cloneResult.currentSha,
      previousSha,
      isNewClone: cloneResult.isNewClone,
      changedFiles: cloneResult.changedFiles,
      skipped,
      jobId: job.id,
    };
  }

  /** Phase 2 of the two-phase pipeline: extract + write graph from an already-cloned repo. */
  async ingestFromClone(cloned: CloneOnlyResult, options: Pick<IngestionOptions, 'repoUrl' | 'serviceMappings'>): Promise<IngestionJob> {
    if (cloned.skipped) return this.sqliteRepo.getJobById(cloned.jobId)!;

    const startedAt = Date.now();
    try {
      const supportedExts = new Set(DEFAULT_SUPPORTED_EXTENSIONS);
      const changedSourceFiles = cloned.changedFiles.filter((f) => {
        const ext = extname(f).toLowerCase();
        return supportedExts.has(ext) && !BINARY_AND_LIBRARY_EXTENSIONS.has(ext);
      });

      const shouldDoFull = cloned.isNewClone || !cloned.previousSha || changedSourceFiles.length > 100;

      if (shouldDoFull) {
        return this.runFullExtraction(cloned.jobId, cloned.localPath, cloned.currentSha, {
          repoUrl: options.repoUrl,
          branch: cloned.branch,
          serviceMappings: options.serviceMappings,
        });
      }

      return this.runIncrementalExtraction(cloned.jobId, cloned.localPath, cloned.currentSha, changedSourceFiles, {
        repoUrl: options.repoUrl,
        branch: cloned.branch,
        serviceMappings: options.serviceMappings,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sqliteRepo.updateJobStatus(cloned.jobId, 'FAILED', { error: errorMessage });
      this.recordRepoState(options.repoUrl, undefined, errorMessage);
      this.logger.error({ jobId: cloned.jobId, error: errorMessage }, 'Ingestion failed');
      metrics.inc('ingest.failed');
      metrics.observe('ingest.duration_ms', Date.now() - startedAt, { status: 'FAILED' });
      return this.sqliteRepo.getJobById(cloned.jobId) ?? { id: cloned.jobId, status: 'FAILED', error: errorMessage } as IngestionJob;
    } finally {
      const final = this.sqliteRepo.getJobById(cloned.jobId);
      if (final?.status === 'COMPLETED') {
        metrics.inc('ingest.success');
        metrics.observe('ingest.duration_ms', Date.now() - startedAt, { status: 'COMPLETED' });
        metrics.inc('ingest.files_processed', final.filesProcessed);
        this.recordRepoState(options.repoUrl, final.commitSha, undefined);
      }
    }
  }

  /** Phase 4 freshness — record per-repo state after each ingest attempt. */
  private recordRepoState(repoUrl: string, sha: string | undefined, errorMessage: string | undefined): void {
    try {
      if (errorMessage) {
        this.repoStateRepo.upsertOnFailure(repoUrl, errorMessage);
      } else if (sha) {
        this.repoStateRepo.upsertOnSuccess(repoUrl, sha);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ repoUrl, err: msg }, 'failed to record repo_state');
    }
  }

  async initGraph(): Promise<void> {
    await this.graphRepo.initIndexes();
  }

  /** Shutdown — terminate worker pool. Call before process exit. */
  async close(): Promise<void> {
    await this.tsPool.close();
  }

  private async computeFileHash(filePath: string): Promise<string> {
    try {
      const content = await readFile(filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).slice(1).toLowerCase();
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript',
      js: 'javascript', jsx: 'javascript',
      mjs: 'javascript', cjs: 'javascript',
      java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
      go: 'go',
      py: 'python', pyi: 'python',
      rs: 'rust',
      rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift',
      c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    };
    return map[ext] ?? 'unknown';
  }
}
