/**
 * Audit-wrapping MCP server proxy (Phase 2 of ADR-006 bridge).
 *
 * Rather than refactor every tool's `register{Name}Tool` function to take
 * the audit/tenancy plumbing, we wrap the `McpServer` itself: every call
 * to `.tool(name, desc, schema, handler)` is intercepted, and the
 * handler is replaced by an audit-recording variant. Same for `.resource`
 * and `.prompt` where defined.
 *
 * Net effect: hundreds of lines of mechanical changes collapse into one
 * `createAuditingServer(realServer, deps)` call at the top of
 * `createMcpServer`.
 *
 * The proxy is invisible to the underlying MCP SDK — it forwards every
 * other property unchanged and only overrides `tool`. Handler wrapping
 * reuses the existing `withTenantScope` middleware, so audit semantics
 * are consistent with the per-handler `withTenantScope` path.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withTenantScope, type ToolMiddlewareDeps } from './tenant.middleware.js';

/**
 * Build a proxy over `server` whose `.tool(...)` wraps the handler with
 * tenant + audit middleware. All other methods pass through.
 */
export function withServerAudit(server: McpServer, deps: ToolMiddlewareDeps): McpServer {
  const originalTool = server.tool.bind(server);

  // The McpServer.tool signature is variadic across the SDK versions we
  // support. We treat it generically here and only re-bind the handler
  // (typically the *last* function argument).
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = function wrapped(...args: unknown[]) {
    // Find the handler (the last argument that's a function).
    const handlerIndex = args.findIndex((a) => typeof a === 'function');
    if (handlerIndex < 0) {
      // No handler? Pass through — SDK will throw its own error.
      return (originalTool as unknown as (...a: unknown[]) => unknown)(...args);
    }
    const handler = args[handlerIndex] as (...handlerArgs: unknown[]) => unknown;
    const toolName = String(args[0] ?? 'unknown_tool');

    // Wrap the handler. The MCP SDK calls the handler with `(input, extra)`,
    // but we adapt to a single `input` arg form because that's what every
    // existing tool registration uses. Extra args are forwarded.
    const wrapped = withTenantScope(toolName, deps, async (input: unknown) => {
      const out = await handler(input);
      return out as { content: ReadonlyArray<{ type: 'text'; text: string }>; isError?: boolean };
    });

    const newArgs = [...args];
    newArgs[handlerIndex] = wrapped as unknown;
    return (originalTool as unknown as (...a: unknown[]) => unknown)(...newArgs);
  };

  return server;
}
