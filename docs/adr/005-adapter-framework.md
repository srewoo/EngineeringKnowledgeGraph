# ADR-005: Pluggable adapter framework for runtime fusion

- **Status:** Accepted
- **Date:** 2026-05-20
- **Reversibility:** Two-way door

## Context

EKG's structural graph (services, files, APIs, schemas) is most valuable
when **fused with runtime reality** — observed traces from Datadog, tickets
from Jira, usage from Mixpanel, logs from Loki. A common shape for these
integrations is needed so the agent can answer cross-source questions
without bespoke wiring per source.

## Constraints

- **Pluggable.** Adding a new source (PagerDuty, Honeycomb, Linear, …)
  shouldn't require changes to the agent layer.
- **Capability-routed.** Different adapters expose different capabilities
  (`metrics`, `traces`, `logs`, `docs`, `tickets`, `usage`, `errors`,
  `alarms`). An agent asking "find related Jira tickets" should not need
  to know which adapter offers `tickets`.
- **Fail-soft.** If an adapter is misconfigured or down, the rest of the
  system keeps working.
- **Local-first compatible.** The default deployment has zero adapters
  configured; the system must work fully without them.

## Options

### Option A — Inline integrations (one client class per source, hardcoded)

Write a Datadog client, a Jira client, a Mixpanel client. Wire each into
the MCP server explicitly.

- **Pros:** Simplest possible code. No registry, no capability routing.
- **Cons:** Every new source touches `server.ts`. The agent has to know
  the name of each tool ("call `get_datadog_metrics`, then
  `get_jira_tickets`"). Cross-source questions ("any tickets for this
  failing service?") need bespoke orchestration code.

### Option B — REST gateway / "API gateway" pattern

Add a thin REST gateway in front of all external systems. EKG calls one
URL with a `{ source, capability, args }` envelope.

- **Pros:** Decouples EKG from each source. Independent deploy cadence.
- **Cons:** Wrong layer of abstraction for a local-first tool. Adds a
  service to deploy. Doesn't solve "which adapter answers `tickets`?"

### Option C — Pluggable adapter framework with capability routing (chosen)

A typed `McpAdapter` interface declares optional capability methods. An
`AdapterRegistry` owns adapter lifecycle. A `CapabilityRouter` fans out a
request to all adapters claiming that capability and merges results.
Adapters can be **native** (Datadog REST), **MCP stdio sub-process**
(spawn an external MCP server like Atlassian's official one and proxy
calls), or **hybrid**.

- **Pros:** New source = one new file implementing `McpAdapter`. The
  agent doesn't learn new tool names; it asks the
  `capability_router` for `tickets` and the right adapter answers.
  Failing adapters are isolated — `disconnect()` and `healthCheck()` are
  required. Composition is the default: ask `errors` and you get a merged
  view across Datadog + Sentry if both are configured. MCP stdio support
  means we can wrap any third-party MCP server with zero code, just
  config.
- **Cons:** Indirection cost. Reading "where do metrics come from?" means
  starting at `CapabilityRouter` and following the chain. A new contributor
  needs ~30 minutes of code-reading to grasp the layout. Some sources
  (e.g. Loki) only answer one capability and don't benefit from routing.

### Option D — LangChain / LlamaIndex tool layer

Use an existing framework's tool registry rather than rolling our own.

- **Pros:** Off-the-shelf. Faster to ship.
- **Cons:** Lock-in to a framework we don't otherwise need. Their tool
  primitives are designed for one-shot LLM tool-use, not multi-source
  capability-routed merging. Larger surface, less control over fail-soft
  behaviour.

## Trade-offs

| Dimension | A (inline) | B (gateway) | **C (adapter fw) ✓** | D (LangChain) |
|---|---|---|---|---|
| New-source cost | High | Med | **Low** | Low |
| Cross-source composition | DIY | DIY | **Native** | Native |
| Local-first fit | OK | Bad | **Best** | OK |
| Lock-in | Per-source | Per-gateway | **None** | Framework |
| Fail isolation | DIY | OK | **Per-adapter** | Per-tool |

## Reversibility

**Two-way door.** Each adapter lives in its own subdirectory under
`packages/adapters/src/<source>/`. Removing the framework means deleting
the registry + router and replacing the calling sites with direct adapter
invocations — a mechanical refactor, no business logic affected.

## Decision

**Pluggable adapter framework with capability routing**, native + MCP-stdio
adapter shapes both supported. Sources implemented today: Datadog (native),
Atlassian / Mixpanel / Loki (MCP-stdio wrappers).

## Consequences

- `packages/adapters` is the contract; everything else (worker, agent,
  MCP tools) talks to it through `AdapterRegistry` + `CapabilityRouter`.
- Phase C's `OBSERVED_CALL` edges and Phase F's eval cases depend on this
  abstraction — the agent doesn't care whether runtime data came from
  Datadog or eBPF.
- Adding a new adapter requires: (a) implement `McpAdapter`,
  (b) a factory function for config-driven instantiation,
  (c) register in `bootstrap.ts`, (d) document capabilities in `ekg.config.json`.
- The adapter framework is the **moat**, per the architect review.
  Investments in this layer (auto-correlated APM, span-level enrichment,
  runtime evidence at query time) compound. Investments in any one source
  do not.
- We deliberately avoid the temptation to add adapter business logic in
  the router. The router is pure dispatch; merging is naive
  (concatenate + dedupe). Smarter merge strategies are per-capability and
  go in the capability-specific layer (e.g. how to dedupe `errors` rows
  across Datadog + Sentry).
