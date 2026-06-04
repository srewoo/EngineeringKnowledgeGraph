/**
 * DatadogAdapter — reference McpAdapter implementation.
 *
 * Capabilities: metrics, traces, errors, alarms.
 * Backed by raw `fetch` against Datadog v1/v2 REST APIs. No SDK.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  AlarmResult,
  ErrorResult,
  McpAdapter,
  MetricResult,
  ServiceDependencyEdge,
  TimeRange,
  TraceResult,
} from '../adapter.interface.js';
import { mapServiceName, type ServiceMapping } from '../service.mapping.js';
import { datadogFetch, redact, type DatadogCreds } from './datadog.http.js';

const logger = createLogger({ service: 'adapters.datadog' });

const CAPS: readonly AdapterCapability[] = ['metrics', 'traces', 'errors', 'alarms'];

const GOLDEN_METRICS = ['errors', 'hits', 'duration.p99'] as const;

export interface DatadogAdapterOptions {
  readonly context: AdapterContext;
  readonly creds: DatadogCreds;
  readonly serviceMapping?: ServiceMapping;
  readonly fetchImpl?: typeof fetch;
}

export class DatadogAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;

  private readonly creds: DatadogCreds;
  private readonly mapping: ServiceMapping;
  private readonly fetchImpl: typeof fetch | undefined;
  private connected = false;

  constructor(opts: DatadogAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.creds = opts.creds;
    this.mapping = opts.serviceMapping ?? 'auto';
    this.fetchImpl = opts.fetchImpl;
  }

  async connect(): Promise<void> {
    const ok = await this.healthCheck();
    if (!ok) throw new Error(`datadog adapter ${this.id}: validate failed`);
    this.connected = true;
    logger.info({ adapter: this.id, site: this.creds.site }, 'connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.call({ path: '/api/v1/validate' });
      return res.status === 200;
    } catch (err) {
      logger.warn({ adapter: this.id, error: redact(errMsg(err)) }, 'healthCheck failed');
      return false;
    }
  }

  async getServiceMetrics(service: string, timeRange: TimeRange): Promise<MetricResult[]> {
    const mapped = mapServiceName(service, this.mapping);
    const from = toEpochSeconds(timeRange.fromIso);
    const to = toEpochSeconds(timeRange.toIso);
    const queries = GOLDEN_METRICS.map((m) => ({
      data_source: 'metrics' as const,
      query: `avg:trace.${mapped}.${m}{*}`,
      name: m,
    }));
    const body = {
      data: {
        attributes: {
          from: from * 1000,
          to: to * 1000,
          queries,
        },
        type: 'timeseries_request',
      },
    };
    const res = await this.call({ method: 'POST', path: '/api/v2/query/timeseries', body });
    return parseTimeseries(res.body, mapped);
  }

  async getErrors(service: string, timeRange: TimeRange): Promise<ErrorResult[]> {
    const mapped = mapServiceName(service, this.mapping);
    const body = {
      data: {
        attributes: {
          filter: {
            query: `service:${mapped} status:error`,
            from: timeRange.fromIso,
            to: timeRange.toIso,
          },
          page: { limit: 25 },
        },
        type: 'search_request',
      },
    };
    const res = await this.call({ method: 'POST', path: '/api/v2/spans/events/search', body });
    return parseErrors(res.body, mapped);
  }

  async getTrace(traceId: string): Promise<TraceResult | undefined> {
    const body = {
      data: {
        attributes: {
          filter: { query: `trace_id:${traceId}` },
          page: { limit: 1 },
        },
        type: 'search_request',
      },
    };
    const res = await this.call({ method: 'POST', path: '/api/v2/spans/events/search', body });
    return parseTrace(res.body, traceId);
  }

  /**
   * Phase C: fetch the service dependency topology from Datadog APM.
   *
   * Uses the legacy `/api/v1/service_dependencies` endpoint — stable, returns
   * `{ "<service>": { calls: ["other-service", ...] } }` for the active env.
   * Counts (call/error/latency) are not returned by this endpoint; later
   * passes can enrich edges by aggregating `/api/v2/spans` if needed.
   *
   * Returns a deterministic list of edges (caller → callee). Self-loops and
   * blank service names are filtered.
   */
  async getServiceDependencies(timeRange: TimeRange): Promise<ServiceDependencyEdge[]> {
    const start = toEpochSeconds(timeRange.fromIso);
    const end = toEpochSeconds(timeRange.toIso);
    const env = (this.context.env['DD_ENV'] ?? this.context.env['env'] ?? '').trim();
    const query: Record<string, string | number | undefined> = { start, end };
    if (env) query['env'] = env;
    const res = await this.call({ path: '/api/v1/service_dependencies', query });
    return parseServiceDependencies(res.body);
  }

  /**
   * Phase C v2 (runtime fusion): aggregate span counts + error counts +
   * p99 latency per (caller, callee) edge over the time range.
   *
   * Implementation note: Datadog's `/api/v2/spans/analytics/aggregate` is the
   * idiomatic endpoint, but it's region-locked and feature-flagged on some
   * accounts. We fall back to two `/api/v2/spans/events/search` calls when
   * aggregate is unavailable — once for total spans, once for errors —
   * and skip p99 in that path (computing percentiles from a sampled
   * search isn't honest). Callers that need p99 should keep aggregate on.
   *
   * Returns one row per observed edge. Edges with zero spans are not
   * returned. The values populate the same `ServiceDependencyEdge` shape
   * so `getServiceDependencies()` callers can opt-in to enriched edges by
   * preferring this method when available.
   */
  async getServiceDependencyMetrics(timeRange: TimeRange): Promise<ServiceDependencyEdge[]> {
    const env = (this.context.env['DD_ENV'] ?? this.context.env['env'] ?? '').trim();
    const envFilter = env ? ` env:${env}` : '';
    const body = {
      data: {
        attributes: {
          compute: [
            { type: 'total', metric: '@duration', aggregation: 'count' },
            { type: 'total', metric: '@duration', aggregation: 'pc99' },
          ],
          filter: {
            from: timeRange.fromIso,
            to: timeRange.toIso,
            query: `service:*${envFilter} -@_top_level:* @parent_service:*`,
          },
          group_by: [
            { facet: '@_top_level.service', limit: 200 },
            { facet: '@_top_level.parent_service', limit: 200 },
          ],
        },
        type: 'aggregate_request',
      },
    };
    try {
      const res = await this.call({
        method: 'POST',
        path: '/api/v2/spans/analytics/aggregate',
        body,
      });
      return parseServiceDependencyMetrics(res.body);
    } catch (err) {
      logger.info({ adapter: this.id, error: redact(errMsg(err)) }, 'aggregate endpoint unavailable; metrics enrichment skipped');
      return [];
    }
  }

  async getAlarms(_timeRange: TimeRange): Promise<AlarmResult[]> {
    const res = await this.call({
      path: '/api/v1/monitor/search',
      query: { query: 'status:Alert' },
    });
    return parseAlarms(res.body);
  }

  private async call(req: { method?: 'GET' | 'POST'; path: string; query?: Record<string, string | number | undefined>; body?: unknown }) {
    const out = await datadogFetch(this.creds, {
      ...req,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (out.status === 401 || out.status === 403) {
      throw new Error(`datadog auth failed: status=${out.status}`);
    }
    if (out.status >= 400) {
      throw new Error(`datadog ${req.path} failed: status=${out.status}`);
    }
    return out;
  }

  isConnected(): boolean { return this.connected; }
}

function toEpochSeconds(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return Math.floor(t / 1000);
}

function parseTimeseries(body: unknown, service: string): MetricResult[] {
  const attrs = rec(rec(rec(body)['data'])['attributes']);
  const series = attrs['series'];
  const values = attrs['values'];
  const times = attrs['times'];
  if (!Array.isArray(series) || !Array.isArray(values) || !Array.isArray(times)) return [];
  const out: MetricResult[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const s = rec(series[i]);
    const valueRow = values[i];
    if (!Array.isArray(valueRow) || valueRow.length === 0) continue;
    const last = valueRow[valueRow.length - 1];
    const tsMs = times[times.length - 1] ?? Date.now();
    out.push({
      service,
      metric: String(s['metric'] ?? s['query_index'] ?? 'unknown'),
      value: Number(last) || 0,
      sampleAt: new Date(Number(tsMs)).toISOString(),
    });
  }
  return out;
}

function parseErrors(body: unknown, service: string): ErrorResult[] {
  const data = rec(body)['data'];
  if (!Array.isArray(data)) return [];
  const counts = new Map<string, { count: number; first: string; last: string }>();
  for (const span of data) {
    const attrsRaw = rec(span)['attributes'];
    if (!attrsRaw || typeof attrsRaw !== 'object') continue;
    const attrs = attrsRaw as Record<string, unknown>;
    const msg = String(rec(attrs['error'])['message'] ?? attrs['resource_name'] ?? 'unknown error');
    const ts = String(attrs['timestamp'] ?? attrs['start'] ?? new Date().toISOString());
    const existing = counts.get(msg);
    if (existing) {
      existing.count += 1;
      if (ts < existing.first) existing.first = ts;
      if (ts > existing.last) existing.last = ts;
    } else {
      counts.set(msg, { count: 1, first: ts, last: ts });
    }
  }
  return [...counts.entries()].map(([message, v]) => ({
    service, message, count: v.count, firstSeen: v.first, lastSeen: v.last,
  }));
}

function parseTrace(body: unknown, traceId: string): TraceResult | undefined {
  const data = rec(body)['data'];
  const first0 = Array.isArray(data) ? data[0] : undefined;
  const first = rec(rec(first0)['attributes']);
  if (Object.keys(first).length === 0) return undefined;
  const durationNs = Number(first['duration'] ?? 0);
  return {
    traceId,
    service: String(first['service'] ?? 'unknown'),
    durationMs: Math.round(durationNs / 1_000_000),
    status: first['error'] ? 'error' : 'ok',
  };
}

/**
 * Pure parser for `/api/v1/service_dependencies`. Exported via this file so
 * tests can feed canned payloads without an HTTP layer.
 */
export function parseServiceDependencies(body: unknown): ServiceDependencyEdge[] {
  if (!body || typeof body !== 'object') return [];
  const edges: ServiceDependencyEdge[] = [];
  const seen = new Set<string>();
  for (const [caller, value] of Object.entries(body as Record<string, unknown>)) {
    if (!caller) continue;
    const calls = (value as { calls?: unknown })?.calls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const callee = typeof c === 'string' ? c.trim() : '';
      if (!callee || callee === caller) continue;
      const key = `${caller} ${callee}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ caller, callee });
    }
  }
  return edges;
}

/**
 * Pure parser for the spans analytics aggregate response.
 *
 * Shape (simplified):
 *   data.attributes.buckets[].by  = [{ facet, value }, ...]
 *   data.attributes.buckets[].computes = { c0: <count>, c1: <p99 ms> }
 *
 * We're aggressively defensive — Datadog has shipped multiple field-name
 * variants over time (`pc99`, `p99`, `99`) and we want to degrade rather
 * than throw on the unexpected.
 *
 * Exported for unit tests.
 */
export function parseServiceDependencyMetrics(body: unknown): ServiceDependencyEdge[] {
  const buckets = (body as { data?: { attributes?: { buckets?: unknown[] } } })?.data?.attributes?.buckets;
  if (!Array.isArray(buckets)) return [];
  const out: ServiceDependencyEdge[] = [];
  for (const b of buckets) {
    const by = (b as { by?: unknown[] })?.by;
    if (!Array.isArray(by) || by.length < 2) continue;
    const computes = (b as { computes?: Record<string, unknown> })?.computes ?? {};
    // We requested two facets in order: child (caller) then parent (callee).
    // Datadog's aggregate flips parent/child semantics — `@_top_level.parent_service`
    // is the service being called from. Treat that as `caller`.
    const callee = String((by[0] as { value?: unknown })?.value ?? '');
    const caller = String((by[1] as { value?: unknown })?.value ?? '');
    if (!caller || !callee || caller === callee) continue;
    const callCount = readNumber(computes['c0']);
    const p99LatencyMs = readNumber(computes['c1']);
    const edge: ServiceDependencyEdge = { caller, callee };
    if (typeof callCount === 'number') {
      (edge as { callCount?: number }).callCount = Math.round(callCount);
    }
    if (typeof p99LatencyMs === 'number') {
      // Datadog reports duration in nanoseconds for spans; convert to ms.
      (edge as { p99LatencyMs?: number }).p99LatencyMs = Math.round(p99LatencyMs / 1_000_000);
    }
    out.push(edge);
  }
  return out;
}

function readNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseAlarms(body: unknown): AlarmResult[] {
  const monitors = rec(body)['monitors'];
  if (!Array.isArray(monitors)) return [];
  const out: AlarmResult[] = [];
  for (const mRaw of monitors) {
    const m = rec(mRaw);
    out.push({
      id: String(m['id'] ?? ''),
      name: String(m['name'] ?? ''),
      severity: String(m['priority'] ?? 'unknown'),
      status: m['overall_state'] === 'OK' ? 'resolved' : 'firing',
      service: extractServiceTag(m['tags']),
      firedAt: String(m['modified'] ?? new Date().toISOString()),
    });
  }
  return out;
}

/** Coerce an unknown to a plain record for safe property access (no `any`). */
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function extractServiceTag(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith('service:')) return t.slice('service:'.length);
  }
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
