export type {
  AdapterCapability,
  AdapterContext,
  TimeRange,
  MetricResult,
  TraceResult,
  ErrorResult,
  LogResult,
  DocResult,
  TicketResult,
  UsageResult,
  AlarmResult,
  McpAdapter,
} from './adapter.interface.js';

export { mapServiceName } from './service.mapping.js';
export type { ServiceMapping } from './service.mapping.js';

export {
  adapterCapabilitySchema,
  serviceMappingSchema,
  adapterConfigSchema,
  adapterConfigArraySchema,
  loadAdapterConfig,
  expandEnvRefs,
} from './adapter.config.js';
export type { AdapterConfig } from './adapter.config.js';

export { AdapterRegistry } from './adapter.registry.js';
export { CapabilityRouter } from './capability.router.js';
export type { RouterOptions, RoutedResult } from './capability.router.js';

export { bootstrapAdapters } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult, AdapterFactory } from './bootstrap.js';

export { DatadogAdapter } from './datadog/datadog.adapter.js';
export type { DatadogAdapterOptions } from './datadog/datadog.adapter.js';
export { createDatadogAdapter } from './datadog/datadog.factory.js';
export { DatadogRuntimeProvider } from './datadog/datadog.runtime.bridge.js';
