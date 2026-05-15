/**
 * Env-read → ConfigKey resolver (Phase 1.6 follow-ups).
 *
 * Pure deterministic matcher: given the per-repo lists of `ParsedEnvRead`
 * sites (collected during file parsing) and `ConfigKey` nodes (emitted by
 * Helm / K8s / dotenv / CI / app-config extractors), produce
 * `Function|Method -[READS_CONFIG]-> ConfigKey` edges.
 *
 * Rules:
 *   - Exact match on `read.key === configKey.properties.key`. If the same
 *     key appears under multiple `envScope`s, emit one edge per match —
 *     downstream traversal can pick the right scope.
 *   - Confidence = HIGH for HIGH-confidence reads, MEDIUM for MEDIUM
 *     (resolved-const indirection in TS/JS).
 *   - No match → silently dropped (would add noise; the read is still
 *     captured on the ParseResult for debugging).
 *   - Cross-repo matching is the IngestionService's job — this pass works
 *     on a single repo's nodes only (same convention as URL→API resolver).
 *   - Hard cap on edges per repo to defend against pathological inputs.
 */

import type {
  ConfigKeyNode,
  GraphRelationship,
  ParsedEnvRead,
  EdgeConfidence,
} from '@ekg/shared';

/** Hard cap on emitted READS_CONFIG edges per repo. */
export const MAX_READS_CONFIG_EDGES = 5_000;

export interface EnvReadInput {
  readonly read: ParsedEnvRead;
  readonly filePath: string;
}

export interface EnvReadResolverInput {
  readonly reads: readonly EnvReadInput[];
  readonly configKeys: readonly ConfigKeyNode[];
}

export interface EnvReadResolverResult {
  readonly relationships: readonly GraphRelationship[];
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly capped: boolean;
}

export class EnvReadResolver {
  resolve(input: EnvReadResolverInput): EnvReadResolverResult {
    const byKey = indexByKey(input.configKeys);
    const out: GraphRelationship[] = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;
    let capped = false;

    for (const { read, filePath } of input.reads) {
      if (!read.callerSymbolId) {
        // No anchoring symbol — we cannot emit a meaningful Function/Method edge.
        unresolvedCount++;
        continue;
      }
      const matches = byKey.get(read.key);
      if (!matches || matches.length === 0) {
        unresolvedCount++;
        continue;
      }

      for (const ck of matches) {
        if (out.length >= MAX_READS_CONFIG_EDGES) {
          capped = true;
          break;
        }
        out.push(buildEdge(read, ck, filePath));
        resolvedCount++;
      }
      if (capped) break;
    }

    return { relationships: out, resolvedCount, unresolvedCount, capped };
  }
}

function indexByKey(configKeys: readonly ConfigKeyNode[]): Map<string, ConfigKeyNode[]> {
  const out = new Map<string, ConfigKeyNode[]>();
  for (const ck of configKeys) {
    const k = ck.properties.key;
    let bucket = out.get(k);
    if (!bucket) { bucket = []; out.set(k, bucket); }
    bucket.push(ck);
  }
  return out;
}

function buildEdge(
  read: ParsedEnvRead,
  ck: ConfigKeyNode,
  filePath: string,
): GraphRelationship {
  const confidence: EdgeConfidence = read.confidence;
  return {
    type: 'READS_CONFIG',
    sourceId: read.callerSymbolId!,
    targetId: ck.id,
    confidence,
    properties: {
      key: read.key,
      sourceFile: filePath,
      sourceLine: read.sourceLine,
      readKind: read.kind,
      configKind: ck.properties.kind,
      ...(ck.properties.envScope ? { envScope: ck.properties.envScope } : {}),
    },
  };
}
