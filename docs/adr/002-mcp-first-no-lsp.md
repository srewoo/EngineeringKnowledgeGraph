# ADR-002: MCP-first protocol, no LSP / REST

- **Status:** Accepted
- **Date:** 2026-05-20
- **Reversibility:** Two-way door

## Context

EKG has one user: an AI agent (Claude / GPT / local LLM). Humans interact
indirectly — through the IDE, a chat surface, or a CLI that wraps the agent.
The protocol choice defines who can build on EKG and how easily.

## Constraints

- **Agent-first.** The primary caller is an LLM, not a human.
- **Local-first.** Default deployment is stdio in the same machine as the
  client. No network hops, no auth, no TLS in the default path.
- **Stable contract.** Adding a new tool should not break existing callers.
- **Composable.** Agents should be able to chain N tools per turn without
  re-establishing context.

## Options

### Option A — REST / GraphQL HTTP API

Familiar, broad ecosystem support, easy to test with curl. Most code-graph
products (Sourcegraph, Glean) use this.

- **Pros:** Universal client library. Easy human exploration. Mature
  observability tooling.
- **Cons:** Agents have to be hand-prompted with the schema. No standard
  "discover tools" affordance — every wrapper reinvents tool routing. Each
  request is a fresh handshake. Auth-by-default forces ops on a local-first
  product that doesn't need it.

### Option B — LSP (Language Server Protocol)

The IDE-native way to expose code intelligence. VS Code / JetBrains / Neovim
all speak it.

- **Pros:** Direct integration with editors. Standard for "go to def" /
  "find references" / "rename" style operations. Streaming + cancellation
  built in.
- **Cons:** LSP is human-shaped. The verbs (hover, completion, definition)
  don't map onto "what tests cover X" or "trace flow end-to-end". Adapting
  LSP to graph queries means inventing custom `workspace/executeCommand`
  payloads — at which point you've reinvented RPC poorly. Multi-tool
  composition is not first-class.

### Option C — Model Context Protocol (MCP) over stdio (chosen)

Anthropic's MCP standard: stdio JSON-RPC, tool/resource/prompt primitives,
discovery built in, designed for agent consumption.

- **Pros:** Tools are self-describing — agents discover and reason about
  them from JSON Schema. Stdio = zero network surface in default mode.
  Resources let us expose graph stats / service lists without a tool call.
  Prompts let us ship template flows (e.g. "impact assessment") versioned
  with the server. Multi-tool composition is the default, not a feature.
  Ecosystem momentum: Claude Code, Cursor, Continue, Cline, Windsurf all
  consume MCP. Building once gets us all those clients.
- **Cons:** MCP is young (released Q4 2024). Tooling for non-stdio
  transports (SSE, WebSocket) is still maturing. Smaller debugger
  ecosystem than HTTP. Most non-AI tooling (Postman, curl) doesn't speak
  MCP — so dev-time exploration needs the `mcp` CLI or a Node REPL.

### Option D — Hybrid (MCP primary + REST for ops endpoints)

Run both. MCP for agent traffic; a thin REST sidecar for metrics, health,
ingestion status.

- **Pros:** Best of both worlds. Ops tooling stays standard.
- **Cons:** Two surfaces to maintain, two auth stories, double the security
  review. The REST surface inevitably grows because "while we're here, add a
  /search endpoint…" and then we've forked the contract.

## Trade-offs

| Dimension | A (REST) | B (LSP) | **C (MCP) ✓** | D (Hybrid) |
|---|---|---|---|---|
| Agent ergonomics | Bad | OK | **Best** | Best |
| Tool discovery | Manual | Manual | **Native** | Native (via MCP) |
| Local-first fit | OK | OK | **Best** | OK |
| Ecosystem reach (2026) | Best | Best (IDE) | OK (growing) | Best |
| Surface to maintain | Single | Single | Single | Double |
| Auth complexity | Required | Required | Optional | Required |

## Reversibility

**Two-way door.** All tools today register through `apps/mcp-server/src/tools/*.tool.ts`. Switching to REST would mean writing thin HTTP handlers that
call the same underlying services (`GraphQueries`, `IngestionService`,
adapters). No business logic lives in the tool layer — it's pure adaptation.
A future REST sidecar can be added in days, not weeks.

## Decision

**MCP-first, single transport, stdio default.** No REST, no LSP, no
hybrid. For HTTP-style surfaces (web UI, Slack bot, on-call dashboards) the
caller wraps an MCP client.

## Consequences

- Every public capability is an MCP tool, resource, or prompt — no
  side-channel endpoints.
- Tool inputs use Zod schemas converted to JSON Schema for discovery.
- Auth defers to the client. Locally there is none; cloud deployments (when
  they exist) wrap the stdio server in a proxy that enforces auth before
  forwarding.
- The `apps/webhook-server` exists for GitLab push-to-ingest webhooks only;
  it does not expose query/answer surfaces. That separation must be kept.
- IDE integration (VS Code, JetBrains) ships as MCP clients, not LSP
  bridges. The Claude Code MCP client is the reference integration.
- If MCP momentum stalls, we reassess. The cost to fall back to REST is
  ~2 weeks of tool-layer rewrites; the design hedges against this by
  keeping business logic out of the tool files.
