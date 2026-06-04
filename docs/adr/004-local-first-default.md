# ADR-004: Local-first single-tenant default

- **Status:** Accepted
- **Date:** 2026-05-20
- **Reversibility:** Two-way door (cloud mode can be added without breaking local)

## Context

EKG's primary user is an engineer with a laptop, an MCP-aware editor, and a
few hundred repos they want to ask questions about. The deployment model
shapes everything: auth, storage durability, secrets handling, multi-user
namespaces, billing.

## Constraints

- **Zero ongoing cost** for the default deployment.
- **Zero cloud dependency** required to be productive.
- **Privacy.** A repo cloned for ingestion must never leave the user's
  machine unless the user opts in to an adapter that ships data outside.
- **Reasonable single-machine scale** — 1K repos, 5M nodes, 20M edges on a
  16GB laptop.

## Options

### Option A — SaaS-first

Hosted Neo4j, hosted MCP server, OAuth login, billing, tenant isolation
from day one.

- **Pros:** One deployment to support. Multi-user from the start. Easier
  monetisation path. Centralised observability.
- **Cons:** Source code leaves the customer's machine — table-stakes
  blocker for enterprise. Authentication, tenancy, encryption-at-rest, and
  audit logging become P0 features. The whole project drifts toward
  "another DevOps platform". Most engineering hours go to making something
  work in production, not making it work *well*.

### Option B — Local-first single-tenant default (chosen)

EKG runs as a docker-compose stack on the user's machine. No auth. No
namespaces. One Neo4j, one SQLite, one MCP server. Adapters opt in to
external calls (Datadog, Atlassian, etc.).

- **Pros:** Zero ops, zero cost, zero privacy concerns. Source code never
  leaves the machine. Iteration speed is maximal — you can change schemas
  without migration ceremony. Aligns with the "AI coding agents at your
  desk" trend.
- **Cons:** No shared graph across a team — each engineer ingests their
  own copy. No centralised dashboards. No "ask the whole company's
  knowledge" UX. The graph DB password is hardcoded in the dev
  compose file (`ekg-local-dev`), which sets a bad precedent for novice
  users who copy the file to a prod box.

### Option C — Self-hosted shared (BYO Neo4j)

Local-first dev, but provide a documented "point this at a shared Neo4j"
path. No multi-tenancy, no auth — but multiple users / agents can read the
same graph.

- **Pros:** Teams get a shared knowledge graph without a SaaS. Ops burden
  is on the team that wants it, not on us.
- **Cons:** Doesn't solve auth. Doesn't solve "user A's adapter token is
  visible to user B". Encourages people to expose Neo4j to the network
  without thinking through the trust model.

### Option D — Local-first default + namespace-on-Repo for future shared mode

Default is single-tenant local. The data model is built such that every
node carries `repoUrl` (and where ambiguous, `tenantId: string` would be
trivially added). Shared / multi-tenant is a *future* deployment mode that
doesn't require rewriting the schema.

This is **B + a hedge**: ship B, but design the schema to absorb tenancy
later without a forklift. See [ADR-006](./006-multi-tenant-deferred.md) for
the migration path.

## Trade-offs

| Dimension | A (SaaS) | **B (Local default) ✓** | C (Self-host shared) | D (B + hedge) |
|---|---|---|---|---|
| Time-to-first-answer | High (signup) | **Low** | Med | Low |
| Privacy posture | Bad | **Best** | OK | Best |
| Ops burden | Heavy | **None** | User's | None |
| Team-wide value | Best | Limited | OK | OK now, Best later |
| Future shared mode | Built-in | Migration needed | Already shared (no auth) | **Designed in** |

(Note: Option D is the chosen variant of B.)

## Reversibility

**Two-way door.** A future hosted / multi-tenant mode is additive: it adds
tenancy fields on nodes, an auth proxy in front of MCP, and a managed
Neo4j cluster. None of that breaks the local path. The local mode stays
the default forever — even if a hosted offering exists.

## Decision

**Local-first single-tenant by default**, with the schema designed to admit
a future shared-tenant mode without a data migration (see
[ADR-006](./006-multi-tenant-deferred.md) for the bridge plan).

## Consequences

- `docker-compose up` at `infra/` is the install path. No external account
  is required to be productive.
- Auth, audit log, encryption-at-rest are explicitly **out of scope** for
  the default deployment. They are documented as "needed if you wrap this
  in a hosted product".
- The Neo4j password in the dev compose is `ekg-local-dev` and the README
  must scream this is not a prod credential. Production deployments must
  override it.
- Adapter tokens (Datadog API key, GitLab token, etc.) live in environment
  variables in the local shell — not in any persistent store under EKG's
  control.
- `repoUrl` is a first-class property on every node we emit so a future
  multi-tenant graph can scope by tenant without re-extracting.
- A future hosted mode will be a **separate deployment target**, not a
  replacement. Local stays free and unauthenticated forever.
