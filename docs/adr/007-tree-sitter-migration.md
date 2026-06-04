# ADR-007: Tree-sitter migration plan for non-TS languages

- **Status:** Proposed
- **Date:** 2026-05-20
- **Reversibility:** Two-way door

## Context

The single largest accuracy risk in EKG is the regex tier in
`packages/parser/src/multi.language.parser.ts`, which extracts symbols
and imports for ~10 non-TS languages (Python, Go, Java, Kotlin, Ruby,
PHP, C#, Swift, Rust, C/C++) by pattern. TypeScript / JavaScript are
the only languages with real AST + type resolution via `ts-morph`.

The architect review estimates the regex tier is wrong ~15–20% of the
time on non-TS code, and crucially, we can't tell which 15–20%. This
undermines the deterministic thesis ([ADR-003](./003-deterministic-extraction.md))
at the seams.

## Constraints

- **Don't break TS / JS**, which is already covered.
- **Incremental.** Migrating all 10 languages at once is a 6-month
  project; we want ongoing wins.
- **Cost cap.** The dependency must work in Node 20, local-first, no
  WASM build steps that break the laptop install.
- **Idempotent migration.** The old regex parser stays as a fallback
  until the new parser is verified for each language.

## Options

### Option A — Do nothing

Live with the regex tier. Improve patterns when bugs are reported.

- **Pros:** Zero engineering cost.
- **Cons:** The accuracy ceiling caps the whole product. The thesis
  ("deterministic graph beats RAG on structural facts") is undercut by
  the 15–20% gap.

### Option B — Per-language language servers (pyright, gopls, JDT)

Spawn a language server per language. The most accurate option — these
are production compilers with full type resolution.

- **Pros:** Maximum accuracy. Cross-language consistency: each is the
  reference implementation for its ecosystem.
- **Cons:** Each language is a separate dep, separate IPC layer,
  separate ops story. Adds ~500MB to the install. Five per-language
  bridges to maintain. Pyright requires Python in PATH; gopls requires
  Go SDK; JDT requires JVM. Hostile to laptop install.

### Option C — Tree-sitter with WASM grammars (chosen)

`web-tree-sitter` runs in pure JS via a WASM build. One Node dep,
per-language grammar files pulled at build time. Tree-sitter is the
de-facto incremental parser used by GitHub's code search, Atom, Neovim.

- **Pros:** Single Node dep, one grammar per language is ~1MB. Real ASTs
  with named node types — `function_definition`, `class_definition`,
  `import_statement`. Production-tested at scale (GitHub uses it). Query
  language (S-expressions) lets us extract the same shapes as ts-morph
  without writing per-language traversal code. Migration can be
  per-language — each grammar adopted independently.
- **Cons:** No type resolution — tree-sitter parses, it doesn't
  type-check. So we still can't answer "what implementations of
  `PaymentProvider` exist" without an extra type-binding pass per
  language. ~85% accuracy vs. ~98% with full language servers. WASM
  loading adds ~50ms cold start.

### Option D — Hybrid: tree-sitter + type binding per language

Tree-sitter for structural extraction; lightweight type binding via
per-language conventions (e.g. resolve `from X import Y` against
`__init__.py`, follow Go package imports). Not full type-check, but
enough to handle the 80% of type questions that matter.

- **Pros:** Closes most of the accuracy gap without the operational
  weight of Option B. Per-language type binding is bounded — ~200
  lines per language.
- **Cons:** Type binding logic is duplicated work that real language
  servers already do. Easy to drift from the language's evolving
  semantics.

## Trade-offs

| Dimension | A (regex) | B (LSPs) | **C (tree-sitter) ✓** | D (tree-sitter + binding) |
|---|---|---|---|---|
| Accuracy on structural | 80% | 98% | **92%** | 96% |
| Accuracy on type questions | Bad | Best | OK | Good |
| Install footprint | Tiny | Huge | **Small** | Small |
| Per-language effort | Low | High | **Medium** | Medium-High |
| Ops complexity | None | Heavy | **Low** | Low |
| Migration risk | None | Per-language ops | **Per-language code** | Per-language code |

## Reversibility

**Two-way door.** Each language's regex implementation stays in
`multi.language.parser.ts` behind a feature flag (`EKG_PARSER_<LANG>=regex|treesitter`)
during the migration. If a tree-sitter grammar is faulty, flip back to
regex per-language without code changes.

## Decision

**Adopt tree-sitter as the structural parser for non-TS languages, one
language at a time.** Start with **Python** as the pilot (largest user
base after TS/JS in our target market). Defer type binding (Option D)
until Phase A is complete for all five priority languages.

## Migration plan (Phase A)

**Pilot — Python** (~2 weeks):
1. Add `web-tree-sitter` dep + `tree-sitter-python` grammar.
2. Create `packages/parser/src/tree-sitter/python.parser.ts` implementing
   the same `ParseResult` shape as `MultiLanguageParser.parseFile` for
   Python.
3. Feature-flag: `EKG_TREESITTER_PYTHON=true` switches the pipeline to
   the new parser for `.py` files.
4. Add ~50 unit tests covering: imports (absolute / relative), classes,
   functions (def / async def), decorators, type hints, async patterns.
5. Run side-by-side against ≥5 real Python repos; diff the extraction.
   Resolve discrepancies — they're either tree-sitter bugs (fix our
   query) or regex bugs (good — the gap we're closing).
6. Make tree-sitter the default for Python; keep regex fallback for one
   release cycle.

**Roll-out — remaining priority languages** (~3 weeks each, in order):

7. Go — `tree-sitter-go`. Lots of structural patterns (interfaces,
   embedded fields) regex handles poorly today.
8. Java — `tree-sitter-java`. Annotations + generics are where regex
   breaks.
9. Kotlin — `tree-sitter-kotlin`. Critical for Android team.
10. Ruby — `tree-sitter-ruby`. Lowest priority but mechanically similar
    to Python.

**Total Phase A:** ~4–6 weeks for Python pilot + 3 weeks per additional
language. Five-language target: ~4 months end-to-end, or shippable in
phases — Python alone delivers the biggest user wins.

## Consequences

- `packages/parser` grows a `tree-sitter/` subdirectory with one file
  per language adopted.
- The regex parser (`multi.language.parser.ts`) remains in place during
  migration and is the documented fallback.
- Type-binding (the Phase A *next* iteration, see Option D) is its own
  ADR when reached — accuracy gains from binding deserve their own
  trade-off review.
- WASM cold-start cost is paid once per worker process; not per file.
  Acceptable.
- We do **not** introduce a per-language LSP bridge in this ADR. If
  type-question accuracy demands rise above what binding can deliver,
  the conversation re-opens — but operational weight is the reason we
  start with tree-sitter.

## Open questions

- Should we ship `tree-sitter-cli` build steps, or pre-build the WASM
  grammars and commit them to the repo? (Likely pre-build, to keep
  laptop install dep-free.)
- Memory budget per worker — tree-sitter ASTs are larger than what
  regex emits. Need to confirm headroom for 5K+ file repos.
- Query syntax learning curve for new contributors. Tree-sitter S-expr
  queries are powerful but unfamiliar. Mitigation: cookbook in
  `packages/parser/README.md`.
