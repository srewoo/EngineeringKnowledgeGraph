/**
 * LokiAdapter — log queries via Grafana Loki HTTP API.
 *
 * Capabilities: logs, errors.
 * Backed by raw `fetch`. No SDK.
 *
 * `getLogs(query, timeRange)` issues `query_range` with nano-second epochs.
 * `getErrors(service, timeRange)` wraps `getLogs` with a level-filter LogQL
 * and aggregates lines by message text (top 25).
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  ErrorResult,
  LogResult,
  McpAdapter,
  TimeRange,
} from '../adapter.interface.js';
import { lokiFetch, redact, type LokiCreds } from './loki.http.js';

const logger = createLogger({ service: 'adapters.loki' });

const CAPS: readonly AdapterCapability[] = ['logs', 'errors'];
const DEFAULT_LIMIT = 500;
const TOP_ERRORS = 25;

export interface LokiAdapterOptions {
  readonly context: AdapterContext;
  readonly creds: LokiCreds;
  readonly fetchImpl?: typeof fetch;
}

export class LokiAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;

  private readonly creds: LokiCreds;
  private readonly fetchImpl: typeof fetch | undefined;
  private connected = false;

  constructor(opts: LokiAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl;
  }

  async connect(): Promise<void> {
    const ok = await this.healthCheck();
    if (!ok) throw new Error(`loki adapter ${this.id}: healthCheck failed`);
    this.connected = true;
    logger.info({ adapter: this.id, baseUrl: this.creds.baseUrl }, 'connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.call({ path: '/ready' });
      return res.status >= 200 && res.status < 400;
    } catch (err) {
      logger.warn(
        { adapter: this.id, error: redact(errMsg(err), this.creds.token) },
        'healthCheck failed',
      );
      return false;
    }
  }

  async getLogs(query: string, timeRange: TimeRange): Promise<LogResult[]> {
    const start = toEpochNs(timeRange.fromIso);
    const end = toEpochNs(timeRange.toIso);
    const res = await this.call({
      path: '/loki/api/v1/query_range',
      query: { query, start, end, limit: DEFAULT_LIMIT, direction: 'backward' },
    });
    if (res.status >= 400) {
      throw new Error(`loki getLogs failed: status=${res.status}`);
    }
    return parseLogs(res.body);
  }

  async getErrors(service: string, timeRange: TimeRange): Promise<ErrorResult[]> {
    const escaped = service.replace(/"/g, '\\"');
    const logql = `{service_name="${escaped}"} | level=~"error|warning"`;
    const logs = await this.getLogs(logql, timeRange);
    return aggregateErrors(service, logs).slice(0, TOP_ERRORS);
  }

  private async call(req: {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  }) {
    const out = await lokiFetch(this.creds, {
      ...req,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (out.status === 401 || out.status === 403) {
      throw new Error(`loki auth failed: status=${out.status}`);
    }
    return out;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function toEpochNs(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ISO timestamp: ${iso}`);
  // ns precision; multiply ms by 1e6, return as string to avoid Number precision loss.
  return `${t}000000`;
}

interface LokiStream {
  readonly stream?: Record<string, string>;
  readonly values?: Array<[string, string]>;
}

function parseLogs(body: unknown): LogResult[] {
  const result = (body as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) return [];
  const out: LogResult[] = [];
  for (const raw of result) {
    const stream = raw as LokiStream;
    const labels = stream.stream ?? {};
    const service =
      labels['service_name'] ?? labels['app'] ?? labels['service'] ?? 'unknown';
    const level = labels['level'] ?? labels['severity'] ?? 'info';
    const values = Array.isArray(stream.values) ? stream.values : [];
    for (const entry of values) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const tsNs = entry[0];
      const message = entry[1];
      out.push({
        service,
        message: String(message ?? ''),
        level: String(level),
        timestamp: nsToIso(String(tsNs)),
      });
    }
  }
  return out;
}

function nsToIso(ns: string): string {
  if (!ns) return new Date(0).toISOString();
  // Trim trailing 6 digits to convert ns → ms; defensive against short inputs.
  const ms = ns.length > 6 ? Number(ns.slice(0, -6)) : Math.floor(Number(ns) / 1_000_000);
  if (!Number.isFinite(ms)) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function aggregateErrors(service: string, logs: readonly LogResult[]): ErrorResult[] {
  const byMessage = new Map<string, { count: number; first: string; last: string }>();
  for (const log of logs) {
    const msg = log.message;
    const existing = byMessage.get(msg);
    if (existing) {
      existing.count += 1;
      if (log.timestamp < existing.first) existing.first = log.timestamp;
      if (log.timestamp > existing.last) existing.last = log.timestamp;
    } else {
      byMessage.set(msg, { count: 1, first: log.timestamp, last: log.timestamp });
    }
  }
  return [...byMessage.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([message, v]) => ({
      service,
      message,
      count: v.count,
      firstSeen: v.first,
      lastSeen: v.last,
    }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
