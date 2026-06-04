# Architecture Decision Records

Decisions that shape EKG's design — recorded so the *why* survives the team
that wrote the code. Every non-trivial architectural choice should leave an
ADR here before it leaves the codebase.

Format follows the standard Nygard template: **Context → Constraints →
Options (≥3 incl. "do nothing") → Trade-offs → Reversibility → Decision.**

## Index

| # | Title | Status | Reversibility |
|---|---|---|---|
| 001 | [Neo4j over Postgres + pgvector](./001-neo4j-over-postgres-pgvector.md) | Accepted | Two-way door (high cost) |
| 002 | [MCP-first protocol, no LSP / REST](./002-mcp-first-no-lsp.md) | Accepted | Two-way door |
| 003 | [Deterministic extraction over LLM in hot path](./003-deterministic-extraction.md) | Accepted | One-way door |
| 004 | [Local-first single-tenant default](./004-local-first-default.md) | Accepted | Two-way door |
| 005 | [Pluggable adapter framework for runtime fusion](./005-adapter-framework.md) | Accepted | Two-way door |
| 006 | [Multi-tenant deferred; namespace-on-Repo as future path](./006-multi-tenant-deferred.md) | Accepted (deferred) | Two-way door |
| 007 | [Tree-sitter migration plan for non-TS languages](./007-tree-sitter-migration.md) | Proposed | Two-way door |

## Why ADRs at all

Three reasons a senior engineer reading this codebase next year will care:

1. **Reversibility surfacing.** Some decisions are one-way doors (you can't
   easily unship a deterministic-extraction stance once 595 tests assume it);
   others are two-way (you can swap Neo4j later). Marking that on each ADR
   keeps panic out of refactor conversations.
2. **Constraint documentation.** "Why didn't you use X?" is the most expensive
   recurring question in any codebase. ADRs answer it once.
3. **Future ADRs depend on past ones.** When ADR-008 is written, the author
   should be able to read 001–007 in one sitting and know the priors.
