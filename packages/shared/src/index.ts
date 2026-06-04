export * from './types/index.js';
export * from './schemas/index.js';
export * from './constants.js';
export { createLogger, createChildLogger, initFileLogging } from './logger.js';
export type { Logger, LoggerOptions } from './logger.js';
export { metrics, MetricsRegistry } from './metrics.js';
export {
  ERROR_CATEGORIES,
  RETRYABLE_ERROR_CATEGORIES,
  classifyError,
  isRetryableErrorCategory,
} from './errors.js';
export type { ErrorCategory } from './errors.js';

// Item 5 — confidence calibration (turns asserted HIGH/MEDIUM/LOW into a measurement).
export { computeCalibration, ASSERTED_CONFIDENCE } from './calibration.js';
export type { ConfidenceBand, EdgeLabel, BandCalibration, CalibrationReport } from './calibration.js';

// Phase 1 of ADR-006 bridge — production readiness guard.
export {
  validateProductionConfig,
  validateProductionConfigOrThrow,
} from './production.guard.js';
export type {
  ProductionGuardInput,
  ProductionGuardResult,
  ProductionGuardViolation,
} from './production.guard.js';

// Phase 2 of ADR-006 bridge — per-request tenancy threading.
export {
  LOCAL_REQUEST_CONTEXT,
  makeRequestContext,
  isLocalContext,
} from './request.context.js';
export type { RequestContext } from './request.context.js';

// Phase 2 — auth + per-tenant secret store interfaces (v0).
export type { TenantResolver, TenantResolveResult, TenantSecretStore } from './auth/auth.interface.js';
export { LocalTenantResolver, StaticTokenTenantResolver } from './auth/local.tenant.resolver.js';
export { EnvTenantSecretStore, InMemoryTenantSecretStore } from './auth/secret.store.js';
