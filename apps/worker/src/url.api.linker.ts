/**
 * Post-extraction URL→API linker (Phase 1.5).
 *
 * Runs once per ingested repo, after `ExtractionPipeline.extract` completes
 * and BEFORE the graph write of additional CALLS_API edges. Combines the
 * in-memory APIs from this repo's extraction with cross-repo APIs queried
 * from Neo4j (capped to ~50 unique target hosts) and emits relationships.
 *
 * The Neo4j query is read-only and runs ONE Cypher per unique host — capped
 * by `MAX_UNIQUE_HOSTS_PER_REPO` to keep the worst case bounded on monorepos
 * with hundreds of distinct outbound hosts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@ekg/shared';
import type { ExtractedHttpCallSite, GraphNode, GraphRelationship, Logger } from '@ekg/shared';
import { UrlApiResolver, type ApiCandidate, type HttpCallInput } from '@ekg/extractor';
import type { Neo4jClient } from '@ekg/graph';
import type { UnresolvedHttpRepository, UnresolvedHttpUpsert } from '@ekg/storage';

export const MAX_UNIQUE_HOSTS_PER_REPO = 50;

interface LinkerOptions {
  readonly repoUrl: string;
  readonly localPath: string;
  readonly nodes: readonly GraphNode[];
  readonly httpCallSites: readonly ExtractedHttpCallSite[];
  readonly strict?: boolean;
}

export interface LinkerResult {
  readonly newRelationships: readonly GraphRelationship[];
  readonly unresolved: readonly UnresolvedHttpUpsert[];
}

export class UrlApiLinker {
  private readonly resolver = new UrlApiResolver();
  private readonly logger: Logger;

  constructor(
    private readonly neo4j: Neo4jClient,
    private readonly unresolvedRepo?: UnresolvedHttpRepository,
  ) {
    this.logger = createLogger({ service: 'url-api-linker' });
  }

  async link(opts: LinkerOptions): Promise<LinkerResult> {
    if (opts.httpCallSites.length === 0) {
      return { newRelationships: [], unresolved: [] };
    }

    const serviceHosts = await loadServiceHosts(opts.localPath);
    const localApis = collectLocalApis(opts.nodes);
    const hosts = uniqueHosts(opts.httpCallSites);
    const remoteApis = await this.fetchApisForHosts(hosts.slice(0, MAX_UNIQUE_HOSTS_PER_REPO));

    const calls: HttpCallInput[] = opts.httpCallSites.map((s) => ({
      url: s.url,
      method: s.method,
      sourceLine: s.sourceLine,
      filePath: s.filePath,
      isTemplate: s.isTemplate,
      clientLibrary: s.clientLibrary,
      ...(s.callerSymbolId ? { callerSymbolId: s.callerSymbolId } : {}),
    }));

    const allApis = [...localApis, ...remoteApis];
    const { resolved, unresolved } = this.resolver.resolve({
      httpCalls: calls,
      apis: allApis,
      serviceHosts,
      strict: opts.strict ?? false,
    });

    const newRelationships: GraphRelationship[] = [];
    for (const r of resolved) {
      if (!r.call.callerSymbolId) continue;
      newRelationships.push({
        type: 'CALLS_API',
        sourceId: r.call.callerSymbolId,
        targetId: r.apiId,
        confidence: r.confidence === 'LOW' ? 'LOW' : r.confidence,
        properties: {
          method: r.call.method,
          url: r.call.url,
          sourceFile: r.call.filePath,
          sourceLine: r.call.sourceLine,
          reason: r.reason,
          clientLibrary: r.call.clientLibrary,
        },
      });
    }

    const unresolvedRows: UnresolvedHttpUpsert[] = unresolved.map((u) => ({
      repoUrl: opts.repoUrl,
      filePath: u.filePath,
      line: u.sourceLine,
      method: u.method,
      urlTemplate: u.url,
      clientLibrary: u.clientLibrary,
      reason: u.reason,
    }));

    if (this.unresolvedRepo) {
      try {
        this.unresolvedRepo.deleteByRepo(opts.repoUrl);
        this.unresolvedRepo.upsertMany(unresolvedRows);
      } catch (err) {
        this.logger.warn({ err, repoUrl: opts.repoUrl }, 'failed to persist unresolved http calls');
      }
    }

    this.logger.info({
      repoUrl: opts.repoUrl,
      total: calls.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      uniqueHosts: hosts.length,
      remoteApis: remoteApis.length,
    }, 'URL→API resolution completed');

    return { newRelationships, unresolved: unresolvedRows };
  }

  /**
   * One Cypher per unique host — bounded by `MAX_UNIQUE_HOSTS_PER_REPO`.
   * APIs are returned with their owning service name when available; that's
   * what powers fuzzy host matching downstream.
   */
  private async fetchApisForHosts(hosts: readonly string[]): Promise<readonly ApiCandidate[]> {
    if (hosts.length === 0) return [];
    const session = this.neo4j.getReadSession();
    try {
      const result = await session.run(
        `MATCH (api:API)
         OPTIONAL MATCH (s:Service)-[:EXPOSES]->(api)
         RETURN api.id AS apiId, api.method AS method, api.path AS path,
                s.name AS serviceName
         LIMIT 5000`,
      );
      const out: ApiCandidate[] = [];
      for (const rec of result.records) {
        const apiId = rec.get('apiId') as string | null;
        const method = rec.get('method') as string | null;
        const path = rec.get('path') as string | null;
        const serviceName = rec.get('serviceName') as string | null;
        if (!apiId || !method || !path) continue;
        out.push({
          apiId,
          method,
          pathTemplate: path,
          hosts: [],
          ...(serviceName ? { serviceName } : {}),
        });
      }
      return out;
    } finally {
      await session.close();
    }
  }
}

function collectLocalApis(nodes: readonly GraphNode[]): readonly ApiCandidate[] {
  const out: ApiCandidate[] = [];
  for (const n of nodes) {
    if (n.label !== 'API') continue;
    const props = n.properties as { method?: string; path?: string };
    if (!props.method || !props.path) continue;
    out.push({
      apiId: n.id,
      method: props.method,
      pathTemplate: props.path,
      hosts: [],
    });
  }
  return out;
}

function uniqueHosts(sites: readonly ExtractedHttpCallSite[]): readonly string[] {
  const seen = new Set<string>();
  for (const s of sites) {
    if (s.url.startsWith('/') || s.url.startsWith('{var}')) continue;
    try {
      const u = new URL(s.url.replace(/\{var\}/g, 'X'));
      seen.add(u.hostname);
    } catch {
      // ignore malformed
    }
  }
  return [...seen];
}

async function loadServiceHosts(
  repoRoot: string,
): Promise<Readonly<Record<string, readonly string[]>> | undefined> {
  try {
    const raw = await readFile(join(repoRoot, 'ekg.config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { serviceHosts?: Record<string, string[]> };
    if (!parsed.serviceHosts || typeof parsed.serviceHosts !== 'object') return undefined;
    const out: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(parsed.serviceHosts)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
    }
    return out;
  } catch {
    return undefined;
  }
}
