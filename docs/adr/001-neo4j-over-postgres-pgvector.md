# ADR-001: Neo4j over Postgres + pgvector

- **Status:** Accepted
- **Date:** 2026-05-20
- **Reversibility:** Two-way door (high migration cost; data model survives the move)

## Context

EKG's central artifact is a typed graph: services, files, APIs, tables,
columns, configs, commits, MRs, observed calls. The dominant workload is
multi-hop traversal — "what depends on X to depth 3", "who exposes column Y",
"trace API → service → DB" — mixed with full-text and vector search for the
semantic surfaces.

The choice of primary store is load-bearing: it constrains how queries are
expressed, how the schema evolves, and how new node/edge types ship.

## Constraints

- **Local-first / ₹0 ongoing cost.** Must run in a single Docker container on
  a laptop with no external dependencies.
- **Multi-hop reads in sub-second.** Variable-length paths up to depth 10
  must be expressible declaratively, not materialised lazily by the app.
- **Schema-flexible.** New edge types (e.g. `OBSERVED_CALL`, `EXPOSES_DATA`)
  should land without a migration step.
- **Native vector index** so semantic search doesn't require a separate store.
- **MCP-first surface.** The agent calls a small number of named tools; ad-hoc
  Cypher (or SQL) is for the *developer*, not the agent.

## Options

### Option A — Postgres + Apache AGE + pgvector

Single store, transactional, familiar. AGE adds Cypher-on-Postgres. pgvector
covers semantic.

- **Pros:** Single Docker image, mature operational story, easy backup,
  existing team comfort.
- **Cons:** Apache AGE is functional but lags Neo4j on traversal optimiser
  quality. Multi-hop variable-length paths are noticeably slower past depth
  3–4. No native graph algorithms (centrality, PageRank) without extensions.
  Confusion between AGE-Cypher and SQL adds cognitive cost. AGE community is
  small; future is uncertain.

### Option B — Postgres only, app-side traversal

Skip the graph layer. Model nodes and edges as relational tables; do
traversal in TypeScript with recursive CTEs.

- **Pros:** Maximum schema flexibility, lowest dependency count, easiest to
  reason about.
- **Cons:** Recursive CTEs are correct but slow for variable-depth, branching
  queries. Every multi-hop path becomes a 50-line CTE — agents will not write
  these reliably. We'd reinvent half of Cypher and ship 1.5x the code.

### Option C — Neo4j 5 Community (chosen)

Native graph store with Cypher, native vector index (5.13+), free Community
edition with single-node deployment.

- **Pros:** Best-in-class traversal performance. Native vector index avoids
  pgvector-style extension juggling. Cypher is a stable, well-documented DSL
  that LLMs already know — the `cypher_query` tool gets a free quality boost.
  `UNWIND` + `MERGE` are first-class, which our batched-write strategy
  depends on.
- **Cons:** Distinct deployment (own docker container, own credentials). No
  ACID across cross-tx writes. Backup/restore is its own tooling. Enterprise
  features (HA cluster, online backup) are paid; OSS path requires DIY for
  production scale. Community version had vector-index limitations until 5.13.

### Option D — Do nothing / use SQLite + JSON for everything

The "no DB" version of B. Fine for a CLI; doesn't survive 1K repos.

## Trade-offs

| Dimension | A (PG + AGE) | B (PG only) | **C (Neo4j) ✓** | D (SQLite) |
|---|---|---|---|---|
| Multi-hop perf | OK | Bad | **Best** | Bad |
| Op simplicity | Best | Best | OK | Best |
| Vector search | OK (pgvector) | OK (pgvector) | **Native** | Manual |
| Schema flex | Good | Best | **Good** | Best |
| Team familiarity | Best | Best | OK | OK |
| Future scale | OK | Limited | **Best (paid HA)** | None |
| Cost to switch later | — | — | **High** (data shape leaks into ORM choice) | — |

## Reversibility

**Two-way door, but expensive.** Switching off Neo4j means rewriting every
Cypher query, every UNWIND batch, every vector index ensure-call. The graph
*schema* (node labels + edge types + properties) survives the move — it's
declarative, lives in `@ekg/shared`. So a future migration is bounded:
~3K lines of repository + query code; no model rewrite.

## Decision

**Use Neo4j 5 Community** as the primary store. Accept the operational
overhead because the traversal quality is the single largest factor in
graph-question latency, and EKG's pitch is "sub-second structural answers."

## Consequences

- Add Neo4j to the laptop quickstart (docker-compose at `infra/`).
- All Cypher must be parameterised and depth-capped (`*1..10`).
- All writes go through `GraphRepository` — never inline. Lets us swap the
  driver later without touching extraction code.
- Vector index creation is lazy + version-gated (Community 5.13+) with a
  brute-force fallback so older deployments still work.
- Production scale (>10M nodes) will eventually need either Neo4j Enterprise
  or a migration to TigerGraph / Memgraph. That's a Phase 4 conversation;
  this ADR doesn't pre-judge it.
