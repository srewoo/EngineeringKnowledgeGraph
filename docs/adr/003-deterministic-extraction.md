# ADR-003: Deterministic extraction over LLM in hot path

- **Status:** Accepted
- **Date:** 2026-05-20
- **Reversibility:** One-way door — reversing means rewriting accuracy invariants across the codebase

## Context

EKG extracts structural facts from source code: imports, routes, SQL schema,
HTTP calls, env vars, message queues. The choice of extraction method
defines what "accuracy" means for the whole product.

## Constraints

- **Sub-second answer latency** for structural questions.
- **Re-ingestible.** Re-running on a fresh checkout must produce the same
  graph, byte-for-byte (modulo timestamps).
- **No hallucination of nodes / edges.** A `(Service)-[:USES]->(Database)`
  edge that points at a database that doesn't exist is worse than missing
  one entirely.
- **Cost cap.** Each ingestion must run for free on a laptop. No per-token
  costs.
- **Auditable.** Every node and edge must trace back to a file / line /
  matcher that produced it.

## Options

### Option A — LLM-first extraction (Cursor / Copilot style)

Feed source files to an LLM with a "extract entities and relationships"
prompt; trust the JSON output.

- **Pros:** Zero rule-writing. Handles every language uniformly. Fluent
  with metaprogramming, decorators, dynamic dispatch.
- **Cons:** Non-deterministic (same input → different graph between runs).
  Per-token cost scales linearly with codebase size — a 10K file repo
  costs ~$5–20 per ingest. Hallucinates ~3–8% of edges. Slow (~minutes per
  repo even with parallelism). No provenance — you can't ask "which line
  produced this edge".

### Option B — Hybrid (deterministic primary + LLM enrichment)

AST/regex for the 80% of facts you can extract structurally; LLM passes for
the residual (e.g. "what does this function do" summaries).

- **Pros:** Deterministic for structural facts; LLMs only do what they're
  good at (natural language summarisation). Cost is bounded.
- **Cons:** Two pipelines to maintain. Edge confidence becomes hard to
  reason about — is `MEDIUM` from regex inference or LLM guess?

### Option C — Deterministic-only in the extraction hot path (chosen)

AST (via `ts-morph` for TS/JS, regex tables for ~10 other languages) for
*all* node/edge extraction. LLMs are allowed in (a) the agent reasoning
layer that *reads* the graph, (b) the embeddings step that *summarises*
nodes for semantic search, (c) the question router for fallback
classification — but **never** in the path that mints nodes or edges.

- **Pros:** Same input → same graph. Re-ingest is a no-op when SHA matches.
  No per-token cost in the dominant path. Every edge traces back to a
  matcher in a parser/extractor module. Confidence taxonomy stays clean:
  HIGH=AST hit, MEDIUM=regex/inference, LOW=fallback fuzzy.
- **Cons:** Accuracy ceiling at the seams of the deterministic parsers. We
  lose on dynamic dispatch, metaprogramming, eval'd strings, runtime-only
  patterns. Adding a new language means writing matcher tables, not just
  prompts.

### Option D — Compiler-frontend extraction (e.g. swc / Babel plugins / treesitter)

Skip the regex tier entirely; use a real parser per language with
type-resolution.

- **Pros:** Highest deterministic accuracy. No regex brittleness.
- **Cons:** Operationally heavy (each language needs its own
  language-server-grade dep). 4–6 weeks per language to get production
  parity with ts-morph. Today's regex tier exists because the all-in cost
  of D was prohibitive.

This is the **goal state** for Phase A — see [ADR-007](./007-tree-sitter-migration.md).

## Trade-offs

| Dimension | A (LLM-first) | B (Hybrid) | **C (Deterministic) ✓** | D (Compiler-grade) |
|---|---|---|---|---|
| Deterministic | No | Partial | **Yes** | Yes |
| Cost per ingest | $$$ | $$ | **Free** | Free |
| Latency | Mins | Mins | **Seconds** | Seconds |
| Accuracy ceiling | ~92% | ~95% | **~85%** | ~98% |
| Provenance | Bad | Mixed | **Excellent** | Excellent |
| Language breadth | Best | Best | OK (10+ via regex) | OK (each lang = work) |
| Operational complexity | OK | Bad | **OK** | Heavy |

## Reversibility

**One-way door for the philosophical stance.** Once 595+ tests assume
deterministic invariants — "re-ingest is idempotent", "edges have
confidence based on matcher type", "every edge has a `sourceLine`" — you
cannot drop LLM extraction into the hot path without invalidating most of
the test suite. A hybrid future (Option B) is plausible *additive to* the
current pipeline, not as a replacement.

## Decision

**Deterministic-only in the extraction hot path.** LLMs may freely enter
the reasoning, summarisation, and routing layers, but not the path that
writes nodes/edges.

## Consequences

- Every new extractor lives under `packages/extractor/src/*.extractor.ts`
  or `packages/parser/src/*.parser.ts` — never invokes an LLM.
- New language support means adding a regex/AST matcher table, *not*
  authoring a prompt.
- The ~15–20% accuracy gap on non-TS languages is a known, named risk.
  Phase A ([ADR-007](./007-tree-sitter-migration.md)) closes it via
  tree-sitter + type resolution.
- Documentation for downstream users must explain the trade: "we tell you
  what *can be statically known*; the agent layer covers everything else."
- When EKG is wrong, it's wrong consistently — which is testable. When
  Option A is wrong, it's wrong unpredictably — which is not.
