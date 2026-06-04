/**
 * Request context — the threading primitive for multi-tenant Phase 2.
 *
 * Every read or write that mutates / reads the shared graph carries a
 * `RequestContext` so the system can:
 *   - stamp `tenantId` on every node/edge written (write isolation)
 *   - filter every read by `tenantId` (read isolation)
 *   - attribute every action to an `actor` for the audit log
 *   - correlate logs across the lifetime of a single request via `requestId`
 *
 * The context flows top-down: an MCP tool receives it (today: synthesised
 * from env config; future: extracted by an auth proxy from JWT/OAuth), and
 * passes it down to `GraphQueries` / `GraphRepository` / adapter calls.
 * Layers that don't care about tenancy (e.g. the embedder) can ignore it.
 *
 * Local-first deployments keep working unchanged: the context defaults to
 * `{ tenantId: 'local', actor: 'system' }`, and every reader/writer treats
 * `'local'` as "show me everything that doesn't claim another tenant".
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCAL_TENANT_ID } from './types/config.types.js';

export interface RequestContext {
  readonly tenantId: string;
  /**
   * Subject of the request — `'system'` for local single-tenant operation,
   * a stable user-id (or service-token-id) in hosted multi-tenant mode.
   */
  readonly actor: string;
  /** Per-request correlation id. Used in logs + audit trail. */
  readonly requestId: string;
}

/**
 * Local-mode context used when no caller-supplied context is available.
 * Treated as "the default tenant" by the graph readers/writers.
 */
export const LOCAL_REQUEST_CONTEXT: RequestContext = Object.freeze({
  tenantId: DEFAULT_LOCAL_TENANT_ID,
  actor: 'system',
  requestId: 'local',
});

/**
 * Build a fresh context. Most callers will use this — the only place that
 * crafts a static context is the local-mode bootstrap.
 */
export function makeRequestContext(input: {
  tenantId?: string;
  actor?: string;
  requestId?: string;
}): RequestContext {
  return {
    tenantId: input.tenantId ?? DEFAULT_LOCAL_TENANT_ID,
    actor: input.actor ?? 'system',
    requestId: input.requestId ?? randomUUID(),
  };
}

/**
 * Convenience predicate — `true` when this context is the default local one.
 * Reader/writer paths use this to decide whether to apply the `'local'`
 * fallback semantics (return rows that lack a `tenantId` property, treating
 * them as belonging to the local tenant).
 */
export function isLocalContext(ctx: RequestContext): boolean {
  return ctx.tenantId === DEFAULT_LOCAL_TENANT_ID;
}
