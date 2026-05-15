/**
 * MixpanelAdapter — usage data via Segmentation report.
 *
 * Capabilities: usage.
 * Backed by raw `fetch` against https://mixpanel.com/api/2.0/. No SDK.
 *
 * `getUsage(event, timeRange)` issues one Segmentation request per call
 * (Mixpanel returns a per-day map), then emits one UsageResult per day in
 * the window. Unique-user counts come from a parallel `unique` report.
 */

import { createLogger } from '@ekg/shared';
import type {
  AdapterCapability,
  AdapterContext,
  McpAdapter,
  TimeRange,
  UsageResult,
} from '../adapter.interface.js';
import { mixpanelFetch, redact, type MixpanelCreds } from './mixpanel.http.js';

const logger = createLogger({ service: 'adapters.mixpanel' });

const CAPS: readonly AdapterCapability[] = ['usage'];

export interface MixpanelAdapterOptions {
  readonly context: AdapterContext;
  readonly creds: MixpanelCreds;
  readonly fetchImpl?: typeof fetch;
}

export class MixpanelAdapter implements McpAdapter {
  readonly id: string;
  readonly capabilities = CAPS;
  readonly context: AdapterContext;

  private readonly creds: MixpanelCreds;
  private readonly fetchImpl: typeof fetch | undefined;
  private connected = false;

  constructor(opts: MixpanelAdapterOptions) {
    this.id = opts.context.id;
    this.context = opts.context;
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl;
  }

  async connect(): Promise<void> {
    const ok = await this.healthCheck();
    if (!ok) throw new Error(`mixpanel adapter ${this.id}: healthCheck failed`);
    this.connected = true;
    logger.info({ adapter: this.id, projectId: this.creds.projectId }, 'connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    try {
      // A cheap, well-defined endpoint — events list scoped to the project.
      const res = await this.call({ path: 'events/names', query: { type: 'general' } });
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      logger.warn(
        { adapter: this.id, error: redact(errMsg(err), this.creds) },
        'healthCheck failed',
      );
      return false;
    }
  }

  async getUsage(event: string, timeRange: TimeRange): Promise<UsageResult[]> {
    const fromDate = toYmd(timeRange.fromIso);
    const toDate = toYmd(timeRange.toIso);
    const baseQuery = {
      event,
      from_date: fromDate,
      to_date: toDate,
      unit: 'day',
    };
    const [totalsRes, uniqueRes] = await Promise.all([
      this.call({ path: 'segmentation', query: { ...baseQuery, type: 'general' } }),
      this.call({ path: 'segmentation', query: { ...baseQuery, type: 'unique' } }),
    ]);
    if (totalsRes.status >= 400) {
      throw new Error(`mixpanel getUsage failed: status=${totalsRes.status}`);
    }
    const totals = parseSegmentation(totalsRes.body, event);
    const uniques = parseSegmentation(uniqueRes.status >= 400 ? {} : uniqueRes.body, event);
    return mergeDaily(event, totals, uniques);
  }

  /** Helper not in the interface — internal/debug only. */
  async getTopEvents(limit = 25): Promise<readonly string[]> {
    const res = await this.call({
      path: 'events/names',
      query: { type: 'general', limit },
    });
    if (res.status >= 400) return [];
    if (!Array.isArray(res.body)) return [];
    return res.body.filter((x): x is string => typeof x === 'string').slice(0, limit);
  }

  private async call(req: {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  }) {
    const out = await mixpanelFetch(this.creds, {
      ...req,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (out.status === 401 || out.status === 403) {
      throw new Error(`mixpanel auth failed: status=${out.status}`);
    }
    return out;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function toYmd(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return new Date(t).toISOString().slice(0, 10);
}

/** Returns map of `YYYY-MM-DD` → count. */
function parseSegmentation(body: unknown, event: string): Map<string, number> {
  const out = new Map<string, number>();
  const series = (body as { data?: { values?: Record<string, Record<string, number>> } })
    ?.data?.values;
  if (!series || typeof series !== 'object') return out;
  // values is `{ event: { 'YYYY-MM-DD': n, ... } }`.
  const eventRow = series[event] ?? Object.values(series)[0];
  if (!eventRow || typeof eventRow !== 'object') return out;
  for (const [day, n] of Object.entries(eventRow)) {
    out.set(day, Number(n) || 0);
  }
  return out;
}

function mergeDaily(
  event: string,
  totals: Map<string, number>,
  uniques: Map<string, number>,
): UsageResult[] {
  const days = new Set<string>([...totals.keys(), ...uniques.keys()]);
  return [...days]
    .sort()
    .map((day) => ({
      event,
      uniqueUsers: uniques.get(day) ?? 0,
      eventCount: totals.get(day) ?? 0,
      window: day,
    }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
