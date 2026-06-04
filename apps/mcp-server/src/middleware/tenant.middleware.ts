/**
 * Tenant-scope middleware for MCP tool handlers (Phase 2 of ADR-006 bridge).
 *
 * Wraps a tool handler so every invocation:
 *   1. Derives the `RequestContext` (today: env-supplied; future: per-request
 *      via auth proxy injecting JWT subject + tenant claim).
 *   2. Runs the handler with that context available.
 *   3. Records an `AuditRow` regardless of success / failure / refused.
 *
 * The wrapper is intentionally non-invasive: existing handlers that don't
 * need tenant scoping just don't use the context parameter. Handlers that
 * do, accept the context as the second arg and pass it to `GraphQueries` /
 * `GraphRepository` calls that already take an optional `RequestContext`.
 *
 * Locally there's exactly one tenant (`'local'`) and exactly one actor
 * (`'system'`). The middleware still records the audit row — operators
 * can disable that via `EKG_AUDIT_LOCAL=false` if they want zero overhead
 * on dev machines.
 */

import {
  LOCAL_REQUEST_CONTEXT,
  makeRequestContext,
  type RequestContext,
} from '@ekg/shared';
import type { AuditRepository, AuditStatus } from '@ekg/storage';

export interface ToolMiddlewareDeps {
  /** Env-supplied tenantId used when no per-request context is available. */
  readonly defaultTenantId: string;
  /** Audit log sink. Optional in local mode unless EKG_AUDIT_LOCAL=true. */
  readonly audit?: AuditRepository;
  /** Whether we're in hosted multi-tenant mode (changes default audit behaviour). */
  readonly hosted: boolean;
}

/**
 * A tool handler that knows about tenancy. Existing handlers can adopt this
 * shape gradually — those that don't will continue to compile because the
 * `RequestContext` arg has a default.
 */
export type TenantAwareToolHandler<I, O> =
  (input: I, ctx: RequestContext) => Promise<O>;

interface McpResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
}

/**
 * Build a context for an incoming tool call. In the local default deployment
 * this is essentially a constant; in hosted mode the auth proxy will set
 * `x-ekg-tenant-id` and `x-ekg-actor` headers which a future stdio bridge
 * will surface via process env per-request.
 *
 * For now we accept env vars as the source so the wiring is testable without
 * a real auth proxy yet:
 *   - EKG_REQUEST_TENANT_ID   — override the env-supplied default
 *   - EKG_REQUEST_ACTOR       — override the actor
 */
export function deriveRequestContext(deps: ToolMiddlewareDeps): RequestContext {
  const tenantId = process.env['EKG_REQUEST_TENANT_ID']?.trim() || deps.defaultTenantId;
  const actor    = process.env['EKG_REQUEST_ACTOR']?.trim()     || (deps.hosted ? 'unknown' : 'system');
  return makeRequestContext({ tenantId, actor });
}

const AUDIT_LOCAL_DEFAULT_OFF = false; // local mode skips audit by default

function shouldRecordAudit(deps: ToolMiddlewareDeps): boolean {
  if (deps.hosted) return deps.audit !== undefined;
  if (!deps.audit) return false;
  return (process.env['EKG_AUDIT_LOCAL'] ?? '').toLowerCase() === 'true'
    || AUDIT_LOCAL_DEFAULT_OFF;
}

/**
 * Wrap a tool handler with tenant context derivation + audit recording.
 * Returns the same shape MCP server expects from registered tools.
 */
export function withTenantScope<I>(
  toolName: string,
  deps: ToolMiddlewareDeps,
  handler: TenantAwareToolHandler<I, McpResult>,
): (input: I) => Promise<McpResult> {
  return async (input: I): Promise<McpResult> => {
    const ctx = deriveRequestContext(deps);
    const startedAt = Date.now();
    let status: AuditStatus = 'ok';
    try {
      const result = await handler(input, ctx);
      if (result.isError) status = 'error';
      return result;
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      if (shouldRecordAudit(deps) && deps.audit) {
        try {
          deps.audit.record({
            tenantId: ctx.tenantId,
            actor: ctx.actor,
            tool: toolName,
            input,
            status,
            latencyMs: Date.now() - startedAt,
          });
        } catch {
          /* audit write must never break the tool path */
        }
      }
    }
  };
}

/**
 * Convenience for handlers that don't need the wrapper but want a context.
 * Useful in places (e.g. resources) that aren't tool-shaped.
 */
export function localContext(): RequestContext { return LOCAL_REQUEST_CONTEXT; }
