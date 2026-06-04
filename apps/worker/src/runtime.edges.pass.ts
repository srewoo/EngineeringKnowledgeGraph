/**
 * Runtime edges pass (Phase C).
 *
 * Materialises observed service-to-service calls from any adapter that
 * implements `getServiceDependencies()` into `OBSERVED_CALL` graph edges,
 * letting agents answer "which services *actually* call payment-service in
 * prod" — distinct from static `CALLS_API` edges inferred at code-extract
 * time.
 *
 * Design choices:
 *   - One adapter per pass (caller picks). Cross-adapter merging is the
 *     CapabilityRouter's job, not ours.
 *   - We never create Service nodes for unknown callers/callees — observed
 *     traffic to a service we haven't ingested is a useful gap signal, not
 *     a reason to invent a stub node. The pass reports those as "unmatched".
 *   - Edges are MERGE-idempotent: re-running over the same window updates
 *     `lastSeenAt` + counters without duplicating edges.
 *   - Source attribution is stamped on every edge via `source: <adapter.id>`
 *     so the graph distinguishes "Datadog said so" from a future eBPF probe.
 *
 * Failure mode: any adapter or DB error is logged and the pass returns the
 * partial result. Never throws into the calling MCP tool.
 */

import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';
import type { McpAdapter, ServiceDependencyEdge, TimeRange } from '@ekg/adapters';
import type { Neo4jClient } from '@ekg/graph';

export interface RuntimeEdgesPassInput {
  readonly adapter: McpAdapter;
  readonly timeRange: TimeRange;
  /** Override which Service node names this adapter's tags map to. Defaults to identity. */
  readonly serviceNameOverride?: (raw: string) => string;
}

export interface RuntimeEdgesPassResult {
  readonly adapterId: string;
  readonly edgesObserved: number;
  readonly edgesMerged: number;
  readonly unmatched: readonly string[];
  readonly durationMs: number;
  readonly skipped?: string;
}

export class RuntimeEdgesPass {
  private readonly logger: Logger;

  constructor(private readonly neo4j: Neo4jClient) {
    this.logger = createLogger({ service: 'runtime-edges-pass' });
  }

  async run(input: RuntimeEdgesPassInput): Promise<RuntimeEdgesPassResult> {
    const startedAt = Date.now();
    const { adapter, timeRange } = input;
    const map = input.serviceNameOverride ?? identity;

    if (typeof adapter.getServiceDependencies !== 'function') {
      return {
        adapterId: adapter.id,
        edgesObserved: 0,
        edgesMerged: 0,
        unmatched: [],
        durationMs: Date.now() - startedAt,
        skipped: 'adapter does not implement getServiceDependencies',
      };
    }

    // Phase C v2: prefer enriched metrics when the adapter exposes them.
    // Fall back to topology-only `getServiceDependencies` so existing
    // adapters still work and topology-only deployments aren't penalised.
    let observed: ServiceDependencyEdge[];
    try {
      observed = typeof adapter.getServiceDependencyMetrics === 'function'
        ? await adapter.getServiceDependencyMetrics(timeRange)
        : [];
      if (observed.length === 0) {
        observed = await adapter.getServiceDependencies(timeRange);
      }
    } catch (err) {
      this.logger.warn({ adapterId: adapter.id, err: errMsg(err) }, 'adapter fetch failed');
      return {
        adapterId: adapter.id,
        edgesObserved: 0,
        edgesMerged: 0,
        unmatched: [],
        durationMs: Date.now() - startedAt,
        skipped: `adapter error: ${errMsg(err)}`,
      };
    }

    if (observed.length === 0) {
      return {
        adapterId: adapter.id,
        edgesObserved: 0,
        edgesMerged: 0,
        unmatched: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const rows = observed.map((e) => ({
      caller: map(e.caller),
      callee: map(e.callee),
      callCount: e.callCount ?? null,
      errorCount: e.errorCount ?? null,
      p99LatencyMs: e.p99LatencyMs ?? null,
    }));

    const result = await this.mergeEdges({
      rows,
      adapterId: adapter.id,
      windowStart: timeRange.fromIso,
      windowEnd: timeRange.toIso,
    });

    this.logger.info({
      adapterId: adapter.id,
      observed: observed.length,
      merged: result.merged,
      unmatched: result.unmatched.length,
      durationMs: Date.now() - startedAt,
    }, 'runtime edges pass complete');

    return {
      adapterId: adapter.id,
      edgesObserved: observed.length,
      edgesMerged: result.merged,
      unmatched: result.unmatched,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * One transaction, two phases:
   *   1. Probe which (caller, callee) pairs both exist as Service nodes.
   *      Unmatched pairs are returned so callers can surface gaps.
   *   2. UNWIND-merge OBSERVED_CALL edges over the matched pairs.
   */
  private async mergeEdges(input: {
    rows: Array<{ caller: string; callee: string; callCount: number | null; errorCount: number | null; p99LatencyMs: number | null }>;
    adapterId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<{ merged: number; unmatched: string[] }> {
    const session = this.neo4j.getSession();
    try {
      // Phase 1 — probe matching Service nodes
      const probe = await session.run(
        `UNWIND $rows AS row
         OPTIONAL MATCH (caller:Service {name: row.caller})
         OPTIONAL MATCH (callee:Service {name: row.callee})
         RETURN row.caller AS caller, row.callee AS callee,
                caller IS NOT NULL AS callerExists,
                callee IS NOT NULL AS calleeExists`,
        { rows: input.rows },
      );

      const matched: typeof input.rows = [];
      const unmatched: string[] = [];
      const byKey = new Map(input.rows.map((r) => [`${r.caller}${r.callee}`, r]));
      for (const rec of probe.records) {
        const caller = rec.get('caller') as string;
        const callee = rec.get('callee') as string;
        const callerExists = rec.get('callerExists') as boolean;
        const calleeExists = rec.get('calleeExists') as boolean;
        if (callerExists && calleeExists) {
          const r = byKey.get(`${caller}${callee}`);
          if (r) matched.push(r);
        } else {
          const missing: string[] = [];
          if (!callerExists) missing.push(caller);
          if (!calleeExists) missing.push(callee);
          unmatched.push(`${caller} -> ${callee} (missing: ${missing.join(', ')})`);
        }
      }

      if (matched.length === 0) {
        return { merged: 0, unmatched };
      }

      // Phase 2 — merge edges over matched pairs
      await session.run(
        `UNWIND $rows AS row
         MATCH (caller:Service {name: row.caller})
         MATCH (callee:Service {name: row.callee})
         MERGE (caller)-[r:OBSERVED_CALL {source: $source}]->(callee)
         ON CREATE SET r.firstSeenAt = $windowStart
         SET r.lastSeenAt = $windowEnd,
             r.confidence = 'HIGH',
             r.evidence = 'runtime',
             r.callCount = row.callCount,
             r.errorCount = row.errorCount,
             r.p99LatencyMs = row.p99LatencyMs,
             r.windowStart = $windowStart,
             r.windowEnd = $windowEnd,
             r.updatedAt = datetime()`,
        {
          rows: matched,
          source: input.adapterId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        },
      );

      return { merged: matched.length, unmatched };
    } finally {
      await session.close();
    }
  }
}

function identity<T>(x: T): T { return x; }
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
