/**
 * McpAdapter — uniform contract for all external MCP integrations.
 *
 * Each adapter implements only the optional methods matching its declared
 * capabilities. The capability router fans out by capability and merges
 * results across adapters.
 */

export type AdapterCapability =
  | 'metrics'
  | 'traces'
  | 'errors'
  | 'logs'
  | 'docs'
  | 'tickets'
  | 'usage'
  | 'alarms';

export interface AdapterContext {
  readonly id: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface TimeRange {
  readonly fromIso: string;
  readonly toIso: string;
}

export interface MetricResult {
  readonly service: string;
  readonly metric: string;
  readonly value: number;
  readonly unit?: string;
  readonly sampleAt: string;
}

export interface TraceResult {
  readonly traceId: string;
  readonly service: string;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
}

export interface ErrorResult {
  readonly service: string;
  readonly message: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface LogResult {
  readonly service: string;
  readonly message: string;
  readonly level: string;
  readonly timestamp: string;
}

export interface DocResult {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly source: string;
}

export interface TicketResult {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly service?: string;
}

export interface UsageResult {
  readonly event: string;
  readonly uniqueUsers: number;
  readonly eventCount: number;
  readonly window: string;
}

export interface AlarmResult {
  readonly id: string;
  readonly name: string;
  readonly severity: string;
  readonly status: 'firing' | 'resolved';
  readonly service?: string;
  readonly firedAt: string;
}

export interface McpAdapter {
  readonly id: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly context: AdapterContext;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  getServiceMetrics?(service: string, timeRange: TimeRange): Promise<MetricResult[]>;
  getErrors?(service: string, timeRange: TimeRange): Promise<ErrorResult[]>;
  getLogs?(query: string, timeRange: TimeRange): Promise<LogResult[]>;
  searchDocs?(query: string): Promise<DocResult[]>;
  getUsage?(event: string, timeRange: TimeRange): Promise<UsageResult[]>;
  searchTickets?(query: string): Promise<TicketResult[]>;
  getAlarms?(timeRange: TimeRange): Promise<AlarmResult[]>;
  getTrace?(traceId: string): Promise<TraceResult | undefined>;
}
