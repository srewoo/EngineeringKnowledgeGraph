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
  const series = (body as any)?.data?.attributes?.series;
  const values = (body as any)?.data?.attributes?.values;
  const times = (body as any)?.data?.attributes?.times;
  if (!Array.isArray(series) || !Array.isArray(values) || !Array.isArray(times)) return [];
  const out: MetricResult[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const s = series[i];
    const valueRow = values[i];
    if (!Array.isArray(valueRow) || valueRow.length === 0) continue;
    const last = valueRow[valueRow.length - 1];
    const tsMs = times[times.length - 1] ?? Date.now();
    out.push({
      service,
      metric: String(s?.metric ?? s?.query_index ?? 'unknown'),
      value: Number(last) || 0,
      sampleAt: new Date(Number(tsMs)).toISOString(),
    });
  }
  return out;
}

function parseErrors(body: unknown, service: string): ErrorResult[] {
  const data = (body as any)?.data;
  if (!Array.isArray(data)) return [];
  const counts = new Map<string, { count: number; first: string; last: string }>();
  for (const span of data) {
    const attrs = span?.attributes;
    if (!attrs) continue;
    const msg = String(attrs.error?.message ?? attrs.resource_name ?? 'unknown error');
    const ts = String(attrs.timestamp ?? attrs.start ?? new Date().toISOString());
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
  const first = (body as any)?.data?.[0]?.attributes;
  if (!first) return undefined;
  const durationNs = Number(first.duration ?? 0);
  return {
    traceId,
    service: String(first.service ?? 'unknown'),
    durationMs: Math.round(durationNs / 1_000_000),
    status: first.error ? 'error' : 'ok',
  };
}

function parseAlarms(body: unknown): AlarmResult[] {
  const monitors = (body as any)?.monitors;
  if (!Array.isArray(monitors)) return [];
  const out: AlarmResult[] = [];
  for (const m of monitors) {
    out.push({
      id: String(m?.id ?? ''),
      name: String(m?.name ?? ''),
      severity: String(m?.priority ?? 'unknown'),
      status: m?.overall_state === 'OK' ? 'resolved' : 'firing',
      service: extractServiceTag(m?.tags),
      firedAt: String(m?.modified ?? new Date().toISOString()),
    });
  }
  return out;
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
