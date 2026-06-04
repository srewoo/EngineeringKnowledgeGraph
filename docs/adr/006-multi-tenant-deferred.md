# ADR-006: Multi-tenant deferred; namespace-on-Repo as future path

- **Status:** Accepted (deferred)
- **Date:** 2026-05-20
- **Reversibility:** Two-way door

## Context

The single-tenant local-first decision ([ADR-004](./004-local-first-default.md))
is sound for the dominant user (engineer with a laptop). But three latent
demands exist: (a) team-wide shared knowledge graphs, (b) enterprise hosted
deployments with isolation per customer, (c) "ask the whole company"
agent scenarios.

Each demands multi-tenant. The question is *when* and *how*.

## Constraints

- Must not invalidate the existing local-first deployment.
- Schema must not require a re-extraction to opt in.
- Auth/audit/encryption posture must satisfy mid-market enterprise security
  reviews (SOC 2 Type II minimum).
- The cost of adding tenancy must not be paid by users who don't need it.

## Options

### Option A — Build multi-tenant now

Add `tenantId` to every node + edge, add an auth proxy, build a managed
Neo4j cluster, ship a hosted offering.

- **Pros:** Future-proof. Enterprise sales can start immediately.
- **Cons:** ~6–8 weeks of work. Forces ops investment before product-market
  fit. Doubles the surface area without clear customer demand.

### Option B — Defer indefinitely, never build it

Local-first forever. If a team wants shared knowledge, they each run their
own EKG and trade snapshots.

- **Pros:** Maximum focus. Zero ops burden.
- **Cons:** Caps the addressable market. Closes the door on enterprise.

### Option C — Defer, but design the schema for tenancy from day one (chosen)

Every node already carries `repoUrl` as a hard-edged scope. We add `tenantId`
(string, default `'local'`) to all node + edge properties on the next schema
bump. When multi-tenant becomes a real ask, the migration is: (a) set
`tenantId` on all existing rows, (b) add a tenant-aware query layer, (c)
deploy an auth proxy in front of the MCP server. The graph data does not
need to be re-extracted.

- **Pros:** Pay almost zero cost today. Two-way door preserved. The
  expensive part (extraction) doesn't need redoing.
- **Cons:** Adds one property to many node types. Small but real.

## Trade-offs

| Dimension | A (build now) | B (never) | **C (defer + hedge) ✓** |
|---|---|---|---|
| Time-to-enterprise | Now | Never | When demanded |
| Today's ops cost | High | None | **Minimal** |
| Schema dirtiness today | Big | None | **Small** |
| Future migration cost | None | N/A | **~2 wk** |

## Reversibility

**Two-way door.** The hedge is intentionally cheap: an unused `tenantId`
property is harmless. If multi-tenant never ships, we have a one-line cleanup.
If it does, the bridge plan below applies.

## Decision

**Defer multi-tenant.** Hedge by ensuring the schema can absorb tenancy
when needed.

## Consequences (deferred — what's checked in today)

- Local single-tenant deployment is the only supported path.
- README does not market a "hosted version".
- Adapter tokens (Datadog, GitLab, Atlassian) are env-var only.

## Bridge plan (when multi-tenant becomes a real ask)

**Phase 1 — Schema** (~1 week):
- Add `tenantId: string` (default `'local'`) to `GraphNode.properties` and
  `GraphRelationship.properties`.
- Update Cypher templates to filter by `$tenantId` in every read.
- Backfill existing data: `MATCH (n) SET n.tenantId = 'local'`.

**Phase 2 — Auth proxy** (~1 week):
- Deploy a thin proxy in front of the MCP stdio server that terminates
  authentication (OAuth or API key) and injects `tenantId` into every
  request context.
- The MCP server reads `tenantId` from a context property and propagates
  it to `GraphQueries` and `IngestionService`.

**Phase 3 — Operational** (~2 weeks):
- Managed Neo4j (Aura or self-hosted with backups, monitoring, encrypted
  storage).
- Per-tenant SQLite shard or row-level isolation.
- Audit log capturing `tenantId`, user, tool, args (redacted), timestamp.

**Phase 4 — Billing & UX** (~2 weeks):
- Tenant onboarding flow.
- Usage metering (ingest count, query count).
- Dashboard for admins.

**Total:** ~6 weeks engineering once a customer asks. Until then, zero
ongoing cost.

## Open questions for the future ADR-when-built

- Do we ship tenant-shared adapters (one Datadog config for the tenant) or
  per-user adapters?
- Per-tenant Neo4j database vs. shared Neo4j with tenant property filter?
  (Lean shared for cost; switch to per-tenant if a big customer demands.)
- Cross-tenant search for org-wide queries — possible or always forbidden?
