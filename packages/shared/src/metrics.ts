/**
 * Lightweight in-process metrics registry.
 *
 * No external dependencies, no Prometheus client — by design. EKG runs locally,
 * so we just expose counters/gauges/histogram-like buckets via `snapshot()`.
 *
 * Use the singleton `metrics` from any package. Instances are shared across
 * the process, but each construction is independent (useful in tests).
 */

interface CounterValue { type: 'counter'; value: number }
interface GaugeValue { type: 'gauge'; value: number }
interface HistogramValue {
  type: 'histogram';
  count: number;
  sum: number;
  min: number;
  max: number;
  /** p50/p95/p99 estimated from a fixed-size reservoir. */
  p50: number;
  p95: number;
  p99: number;
}

type MetricValue = CounterValue | GaugeValue | HistogramValue;

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();
  private readonly startedAt = Date.now();

  inc(name: string, by = 1, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    let arr = this.samples.get(key);
    if (!arr) { arr = []; this.samples.set(key, arr); }
    arr.push(value);
    // Reservoir cap to keep memory bounded
    if (arr.length > 1024) arr.splice(0, arr.length - 1024);
  }

  /** Time an async or sync operation; records duration in ms under `name`. */
  async time<T>(name: string, fn: () => Promise<T> | T, labels?: Record<string, string>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(`${name}.duration_ms`, Date.now() - start, labels);
    }
  }

  /** Snapshot of all metrics. Read-only; computed on demand. */
  snapshot(): {
    uptimeMs: number;
    counters: Record<string, CounterValue>;
    gauges: Record<string, GaugeValue>;
    histograms: Record<string, HistogramValue>;
  } {
    const counters: Record<string, CounterValue> = {};
    for (const [k, v] of this.counters) counters[k] = { type: 'counter', value: v };

    const gauges: Record<string, GaugeValue> = {};
    for (const [k, v] of this.gauges) gauges[k] = { type: 'gauge', value: v };

    const histograms: Record<string, HistogramValue> = {};
    for (const [k, samples] of this.samples) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      const sum = sorted.reduce((s, n) => s + n, 0);
      histograms[k] = {
        type: 'histogram',
        count: sorted.length,
        sum,
        min: sorted[0]!,
        max: sorted[sorted.length - 1]!,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      };
    }
    return { uptimeMs: Date.now() - this.startedAt, counters, gauges, histograms };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.samples.clear();
  }

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    return `${name}{${parts.join(',')}}`;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

/** Process-wide singleton. */
export const metrics = new MetricsRegistry();
