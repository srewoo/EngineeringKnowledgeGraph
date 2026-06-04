# Engineering Knowledge Graph (EKG)

> A compiler for engineering systems — not a CRUD backend.

EKG is a **local-first, backend-only MCP server** that ingests multi-language
repositories (TypeScript, Java, Kotlin, Go, Python, Rust, Ruby, PHP, C#, C/C++,
Scala, Swift), extracts structural relationships using deterministic AST + regex
analysis, stores them in a Neo4j knowledge graph, and exposes everything via
MCP tools so AI agents like Claude can answer real engineering questions about
your code estate.

It also wraps **external MCP servers** (Datadog, Atlassian, Mixpanel, Loki) so
the same agent loop can pull runtime, ticket, doc, and log data when answering.

---

## What it can answer

| Capability | Example question | EKG tool |
|---|---|---|
| **Code search** | "Find every `INSERT IGNORE` in user-management Go files" | `code_grep` |
| **Symbol search** | "Where do we calculate proficiency score?" | `search_codebase` (hybrid BM25+vector), `graph.find_function` |
| **Service intelligence** | "What does activity-service do, who owns it, what depends on it?" | `get_service_summary`, `get_dependencies`, `analyze_impact` |
| **API map** | "Which endpoint creates a coaching session?" | `get_api_map`, `search_codebase(label:"API")` |
| **Schema** | "Which column on the users table marks deletion?" | Graph contains `Table` + `Column` nodes with PRISMA / TypeORM / Drizzle / Sequelize / SQLAlchemy / Django / GORM / sqlc / raw SQL DDL / Liquibase coverage. |
| **Kafka topology** | "Which services produce to `meeting.transcript.ready`?" | `synthesize_flow`, `cypher_query` against `Topic`/PRODUCES/CONSUMES |
| **Cross-service deps** | "Compare declared vs runtime deps for orders-service" | `compare_dependencies` (graph + Datadog runtime peers) |
| **GitLab MR review** | "Review MR …/merge_requests/123, flag rollout risks" | `gitlab_get_mr` |
| **Natural language Q&A** | "What happens end-to-end when a learner starts a course?" | `ask_question` / `answer_question` (Phase 3 agent loop) |
| **Atlassian + Mixpanel + Loki** | "Did the X event fire today?" / "Show me errors in person-service" | `adapter_query` (capability-routed) |
| **Cross-service resolution rate** | "What fraction of HTTP calls did we link to an API?" | `list_unresolved_http_calls(mode:"stats")` |
| **Extraction coverage** | "Which services have no schema/owner/topic — where are the gaps?" | `coverage_report` |
| **Confidence calibration** | "Is a MEDIUM edge actually ~70% likely to be right?" | `calibrate(mode:"sample"\|"score")` |

---

## Quick start

### 0. Prerequisites

- **Node.js ≥ 20**
- **Docker** (for Neo4j; Neo4j Community Edition starts via the supplied compose file)
- **Optional**: [Ollama](https://ollama.ai) for local-first embeddings + LLM
  (`brew install ollama`, then `ollama serve`, then `ollama pull nomic-embed-text`).

### 1. Install dependencies

```bash
npm install
```

### 2. Start Neo4j

```bash
cd infra && docker compose up -d
# Neo4j browser: http://localhost:7474  (neo4j / ekg-local-dev)
```

### 3. Configure environment

```bash
cp .env.example .env
$EDITOR .env
```

Minimum to set:

| Variable | Required for | Why |
|---|---|---|
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Always | Graph store. Defaults match `infra/docker-compose.yml`. |
| `GIT_TOKEN` | `ingest_repo`, `bulk_ingest`, `gitlab_get_mr` | GitLab personal access token. Scopes: `read_repository`, `read_api`. |
| `GITLAB_GROUP_IDS` | `bulk_ingest`, `discover_repos` | Comma-separated GitLab group IDs. |
| `EKG_EMBEDDINGS_ENABLED=true` | `search_semantic`, hybrid `search_codebase`, `ask_question` | Turns on the post-ingest embedder. |
| `EKG_EMBEDDING_PROVIDER` | If embeddings enabled | `ollama` (free, local) / `openai` / `voyage`. |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | LLM router/agent | Set the one matching `EKG_AGENT_PROVIDER`. |

See `.env.example` for the full matrix with comments per variable.

### 4. Build

```bash
npm run build
```

### 4b. Quality gate (eval regression block)

Answer quality is protected by an eval gate that runs with **zero infrastructure**
(deterministic router classifier over the full eval set in `packages/eval/eval-set/`):

```bash
npm run eval:gate          # PASS/FAIL verdict; non-zero exit on failure
npm run eval:gate:update   # accept current run as the new baseline (commit baseline.json)
```

It enforces an absolute classifier-accuracy floor **and** no >5pp regression vs the
frozen `baseline.json`. The same check runs as a unit test (`classifier.gate.test.ts`,
so `npm test` enforces it) and as a dedicated CI job (`.github/workflows/ci.yml`), so an
extractor/router change that silently degrades routing can't merge.

Two further gates run with the same zero-infra approach:

```bash
# Retrieval gate — FixtureAgent over a committed synthetic graph; enforces
# citation recall/precision (fixture.cases.json + fixture.graph.json).
node packages/eval/dist/cli.js gate \
  --cases packages/eval/eval-set/fixture.cases.json \
  --fixture packages/eval/eval-set/fixture.graph.json \
  --baseline packages/eval/eval-set/fixture.baseline.json --min-recall 0.9

# Confidence calibration — measures observed-vs-asserted accuracy per band
# (ECE / Brier) from a labelled edge sample → calibration.report.md.
npm run eval:calibration
```

Lint (`npm run lint`, ESLint v9 flat config) and `tsc --build` round out the CI gate.

### 5. Start the MCP server (manually, for verification)

```bash
node apps/mcp-server/dist/index.js
```

You should see `EKG MCP Server running on stdio` then a quiet stdin loop.
Hit Ctrl-C and move to the next step — actual usage is via an MCP client.

### 6. Connect to an MCP client

#### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ekg": {
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/CodeSage"
    }
  }
}
```

(Environment is inherited from the project `.env` because `index.ts` resolves
it via `dirname(import.meta.url)`. You don't need to duplicate env vars in
the JSON unless you want to override per client.)

#### Claude Code (CLI)

```bash
cd /path/to/CodeSage
claude mcp add ekg node apps/mcp-server/dist/index.js
```

Or place the same JSON snippet above into `.mcp.json` at the workspace root.

#### Verify

In your MCP client:

```
@ekg get_metrics
```

You should get back `nodes`, `edges`, `parser.pool.size`, plus uptime.

### 7. Inspector / dev server

For a local web UI you can poke without an LLM client:

```bash
npx @modelcontextprotocol/inspector node apps/mcp-server/dist/index.js
```

---

## Usage workflows

### Ingest a single repo

```
@ekg ingest_repo url="https://gitlab.com/myorg/my-service" branch="main"
@ekg get_ingestion_status query="https://gitlab.com/myorg/my-service"
```

### Bulk-ingest an entire org (~1000 repos)

```
@ekg discover_repos groupIds="6877322"        # preview repo count + sizes
@ekg bulk_ingest    groupIds="6877322"        # kicks off background job
@ekg get_ingestion_status query="bulk-..."    # poll progress
```

Bulk ingest is **smart-incremental**:

- Same SHA as last run → skipped (~50–200 ms per repo).
- ≤100 changed files → incremental (re-parse only changed files).
- >100 changed files → full re-extract.
- Repos > `MAX_REPO_SIZE_MB` → auto-skipped.
- Failures are written to a SQLite **DLQ** with categorized errors.

### Inspect failures + retry

```
@ekg list_dlq                          # see what failed and why
@ekg retry_dlq bulkJobId="bulk-..."    # retry by job
@ekg retry_dlq category="CLONE_FAILED" # or by category
@ekg retry_failed action="start"       # or retry every repo whose latest job FAILED
```

Error categories: `TIMEOUT`, `CLONE_FAILED`, `PARSE_FAILED`, `NEO4J_LOCK`,
`OOM`, `UNKNOWN`. The DLQ persists across MCP restarts (in `data/ekg.db`).

### Resolve cross-service URLs after a bulk ingest

```
@ekg resolve_services
```

This walks unresolved HTTP call sites (`https://...`, K8s DNS, env-substituted
templates) and links them to API nodes, materialising `CALLS_API` edges
between services. Always run **after** every bulk ingest.

### Query the graph

```
@ekg list_services
@ekg list_databases
@ekg get_service_summary service="user-service"
@ekg get_dependencies service="user-service" depth=3
@ekg analyze_impact node="postgres" depth=4
@ekg get_api_map service="user-service"
```

### Code search

```
@ekg code_grep pattern="INSERT\\s+IGNORE" languages='["go"]' repos='["user-service","entity-service"]'
@ekg search_codebase query="auth token verification" label="Function" mode="hybrid"
@ekg search_semantic query="proficiency score calculation" label="Function"
```

### Ad-hoc Cypher (read-only)

```
@ekg cypher_query query="MATCH (s:Service)-[:USES]->(d:Database) RETURN s.name, d.name LIMIT 50"
```

Writes (`CREATE/MERGE/SET/DELETE/REMOVE/DROP/FOREACH/LOAD CSV`) are
hard-rejected. Auto-`LIMIT $maxRows` is appended if missing. Only read-only
APOC procedures are permitted.

### Natural-language Q&A

Requires `EKG_AGENT_ENABLED=true`, `EKG_AGENT_PROVIDER`, and the matching key.

```
@ekg ask_question      question="Which endpoint creates a coaching session?"
@ekg answer_question   question="What happens when a learner starts a course?"
```

`ask_question` returns ranked retrieval results + the routing trace.
`answer_question` runs the full agent loop (graph + retrieval as tools) and
returns a cited prose answer.

### MR review

```
@ekg gitlab_get_mr url="https://gitlab.com/myorg/my-service/-/merge_requests/123"
```

Returns MR metadata, diff stats, discussions, pipelines, approvals, plus risk
heuristics (helm/k8s/migration/CI/secrets touched, large diff, failing
pipeline, no approvers, "BREAKING CHANGE" in description).

### Declared vs runtime dependency diff

```
@ekg compare_dependencies service="orders-service" windowMinutes=60
```

Returns three sets:

- **overlap** — declared in code AND seen in prod traffic
- **declaredOnly** — declared but unused (dead dep or low-traffic feature)
- **runtimeOnly** — talked to in prod but not in the graph (likely an
  unresolved cross-service URL — try `resolve_services`).

`runtimeOnly` is empty unless the Datadog adapter is enabled.

### Snapshot + diff (Phase 5)

```
@ekg snapshot_graph name="2026-05-18-baseline"
@ekg diff_snapshots fromName="..." toName="..."
```

### Reports (MCP prompts)

```
@ekg use prompt: dependency-report   service="user-service"
@ekg use prompt: impact-assessment   node="Couchbase" changeType="db_change"
```

---

## MCP interface

### Tools (~30)

| Tool | What it does |
|---|---|
| **Ingestion** | |
| `ingest_repo` | Clone + ingest a single repo |
| `discover_repos` | Preview a GitLab group (with sizes) |
| `bulk_ingest` | Background bulk ingest (concurrency-controlled) |
| `resolve_services` | Link unresolved HTTP calls to API nodes |
| `get_ingestion_status` | Per-repo / bulk-job status |
| `retry_failed` | Re-run repos whose latest job FAILED |
| `list_dlq` / `retry_dlq` | Inspect + replay the dead-letter queue |
| `data_freshness` | Per-repo `last_ingested_at` (alert if stale) |
| `ingest_on_push` | Hook for the webhook server |
| **Search** | |
| `search_codebase` | Hybrid BM25 + vector + RRF + (optional) reranker, 1-hop graph expansion |
| `search_semantic` | Vector-only |
| `code_grep` | Literal/regex over `data/repos/<repo>/` (5K files / 500 matches / 30s cap) |
| **Graph** | |
| `list_services` / `list_databases` | Catalog views |
| `get_service_summary` / `get_api_map` | Detailed per-service overview |
| `get_dependencies` / `analyze_impact` / `analyze_impact_v2` | Forward + reverse traversal |
| `synthesize_flow` | Produces a Mermaid sequence diagram for a user-action flow |
| `cypher_query` | Read-only Cypher escape hatch |
| `list_unresolved_http_calls` | Debug aid for `resolve_services` |
| **Snapshots** | |
| `snapshot_graph` / `diff_snapshots` | Time-travel comparison |
| **External adapters (Phase 6)** | |
| `list_adapters` | Show registered MCP adapters + health |
| `adapter_query` | Capability-routed call (logs/docs/usage/metrics) |
| `runtime_evidence` | Datadog-backed corroboration of graph edges |
| **Q&A** | |
| `ask_question` | Router + retrieval, returns ranked results |
| `answer_question` | Full agent loop with citations |
| **Other** | |
| `gitlab_get_mr` | MR review payload |
| `compare_dependencies` | Declared vs runtime peer diff |
| `submit_feedback` | Capture thumbs-up/down on answers |
| `eval_run` | Run the eval set in `packages/eval/cases/` |
| `get_metrics` | EKG runtime metrics |

### Resources

| URI | Description |
|---|---|
| `ekg://graph-stats` | Live node + edge counts + connection state |
| `ekg://metrics` | Counters / gauges / histograms |
| `ekg://services` | All Service nodes |
| `ekg://databases` | All Database nodes |

### Prompts

| Prompt | Description |
|---|---|
| `dependency-report` | Structured dep report for a service |
| `impact-assessment` | Impact assessment for a proposed change |

---

## Architecture

```
                   ┌──────────────────────────────────┐
                   │     Git Repos (1 → 1000+)        │
                   └─────────────┬────────────────────┘
                                 │ clone (shallow + filter=blob:limit=2m)
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │                   Worker / Pipeline                  │
        │                                                      │
        │  RepoCloner  ─→  ExtractionPipeline                  │
        │                  ├── TypeScriptParserPool (worker_threads)
        │                  ├── MultiLanguageParser  (regex)    │
        │                  ├── MultiLangSymbolsParser (Py/Go)  │
        │                  ├── ApiSchemaScanner (OpenAPI/.proto/GraphQL)
        │                  ├── ConfigScanner   (env / docker)  │
        │                  ├── MarkdownExtractor               │
        │                  ├── Schema*Extractor                │
        │                  │     • Prisma                      │
        │                  │     • TypeORM/Drizzle/Sequelize   │
        │                  │     • SQLAlchemy/Django           │
        │                  │     • GORM/sqlc                   │
        │                  │     • Raw SQL DDL + Liquibase     │
        │                  ├── KafkaMultiLangExtractor (Py/Go/JVM)
        │                  └── MetadataScanner (CODEOWNERS+git)│
        └─────────────┬───────────────────────────────────────┘
                      │ idempotent UNWIND batches
                      ▼
        ┌──────────────────────────────────────────────────────┐
        │  Storage                                             │
        │   • Neo4j 5    (graph)                               │
        │   • SQLite     (jobs, DLQ, repo state, snapshots)    │
        │   • Embeddings (sibling SQLite + cosine search)      │
        │   • BM25 / FTS5 (sibling SQLite)                     │
        └─────────────┬───────────────────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────────────────────────────────┐
        │  Retrieval / Routing / Agent (Phases 2 + 3)          │
        │   HybridSearch → Reranker → 1-hop GraphExpander      │
        │   QuestionRouter (LLM) → tool-using Agent (LLM)      │
        └─────────────┬───────────────────────────────────────┘
                      │
                      ▼
                ┌────────────────┐
                │  MCP server    │     ←  AI agents (Claude / Cursor)
                │  (stdio)       │
                └────────────────┘
                      │
                      ▼  (Phase 6 adapter framework)
        ┌─────────────────────────────────────────────────────┐
        │  Datadog | Atlassian | Mixpanel | Loki | …          │
        └─────────────────────────────────────────────────────┘
```

### Layered packages

| Path | Role | Depends on |
|---|---|---|
| `apps/mcp-server` | MCP stdio server, registers tools/resources/prompts | all packages |
| `apps/worker` | Ingestion pipeline driver | parser/extractor/graph/storage/embeddings |
| `apps/webhook-server` | GitLab push webhook → incremental ingest | worker, shared, storage, graph |
| `packages/parser` | TS/JS via ts-morph, multi-lang regex, GitLab/GitHub clients | shared |
| `packages/extractor` | All schema/symbol/import/api/config/owner extractors | parser, shared |
| `packages/graph` | Neo4j client + UNWIND-batched repo + queries + cache | shared |
| `packages/storage` | SQLite repos (jobs, DLQ, embeddings, search-text, snapshots) | shared |
| `packages/embeddings` | OpenAI / Voyage / Ollama providers | shared |
| `packages/search` | Hybrid (BM25+vector+RRF) + rerankers + graph expansion | shared, embeddings, storage |
| `packages/router` | LLM router, classifier, plan executor | shared |
| `packages/agent` | Tool-using agent loop, prompt scaffolding, answer contract | search, graph, storage |
| `packages/observability` | Trace / cost meter / budget / feedback | shared, storage |
| `packages/eval` | RAGAS-style eval runner + cases loader | router, agent |
| `packages/advanced` | Flow synthesis, snapshots, runtime registry | graph |
| `packages/adapters` | Datadog/Atlassian/Mixpanel/Loki adapters + bootstrap | shared, advanced |
| `packages/shared` | Types, schemas, constants, Pino logger | (none) |

---

## What gets extracted

| Category | Coverage |
|---|---|
| **Imports** | TS/JS ES + CJS, Java/Kotlin/Scala `import`, Go `import (...)`, Python `import`/`from`, Rust `use`/`extern crate`, Ruby `require`, PHP `use`/`require`, C# `using`, C/C++ `#include` |
| **Functions / classes / methods** | TS/JS via ts-morph (full AST). Python and Go via deterministic regex (declarations, receivers, classes, docstrings/godoc). |
| **API routes** | Express / Fastify / Koa / NestJS decorators, Spring `@*Mapping`, JAX-RS, FastAPI / Flask / Django, Gin / Echo / Fiber / Mux / `net/http`, Actix / Axum, Rails / Laravel, ASP.NET `[HttpGet]` |
| **API schemas** | OpenAPI 3 + Swagger 2 (with `requestSchema` / `responseSchemas` JSON-stringified), gRPC `.proto`, GraphQL SDL |
| **Databases** | 30+ SDKs across languages (Couchbase, Mongo, Postgres, MySQL, Redis, Cassandra, Elasticsearch, Neo4j, MSSQL, Oracle, Hibernate, GORM, SQLx, Diesel, …) |
| **Schema (tables/columns)** | Prisma, TypeORM, Drizzle, Sequelize, SQLAlchemy declarative + core, Django, GORM, sqlc, raw SQL DDL (CREATE/ALTER/DROP), Liquibase changelogs (`tableName`, `<column>`, `<addColumn>`, …). Each emits `Table` + `Column` nodes + `HAS` edges; migrations also get `Migration` + `ALTERS` edges. |
| **Kafka** | TS/JS via ts-morph (kafkajs / NestJS decorators / Confluent). Python (kafka-python, confluent-kafka, aiokafka), Go (Sarama, segmentio/kafka-go, confluent-kafka-go), Java/Kotlin/Scala (`@KafkaListener`, KafkaTemplate, ProducerRecord). Producers + consumers cross-link via shared `Topic` nodes. |
| **HTTP outbound calls** | Multi-language: axios/fetch/got/undici/ky (TS/JS, template literals supported), requests/httpx/aiohttp (Python), `net/http`/resty (Go), RestTemplate/OkHttp (Java), reqwest (Rust), Net::HTTP/HTTParty (Ruby), Guzzle (PHP), HttpClient (C#). |
| **Configs** | `.env` templates, JSON configs, `docker-compose.yml`, Helm `values.yaml`, K8s manifests, `.gitlab-ci.yml`, GitHub Actions workflows, app config files. Emits `ConfigKey` nodes + `READS_CONFIG` / `USES_SECRET` edges. |
| **Env variables** | `process.env.*`, `os.Getenv`, `os.environ`, `System.getenv`, `std::env::var`, `ENV[]`, `Environment.GetEnvironmentVariable` |
| **Documentation** | `.md`, `.mdx`, `.rst`, `.adoc` → `Doc` nodes (kind: README/RUNBOOK/ADR/CHANGELOG/PRD/OTHER) with headings, code blocks, links. |
| **Ownership** | CODEOWNERS from `/`, `.github/`, `.gitlab/`, `docs/` → `Owner` / `Team` nodes with `OWNS` edges. |
| **Repo metadata** | Latest commit SHA + timestamp on the `Repo` node. Per-`File` `sizeBytes`, `loc`, `lastChangedAt` (one bounded `git log`). |
| **Services** | Detection priority: `ekg.config.json` mappings → monorepo `apps/*` / `packages/*` / `services/*` / `libs/*` with `package.json` → Dockerfile per dir → fallback (whole repo). |
| **Cross-service** | URL → service resolution: hostname, K8s DNS (`*.svc.cluster.local`), env-substituted templates (`${USER_SERVICE_URL}`), kebab/underscore variants. Resolved edges become `CALLS_API`. |

### Skipped

`.jar/.war/.class/.exe/.dll/.so/.dylib/.dmg/.pkg/.zip/.tar/.gz/.png/.jpg/.svg/
.pdf/.mp4/.ttf/.woff/.min.js/.min.css/...`, every common lockfile
(`package-lock.json`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`,
…), and any source file > **2 MB**.

---

## Configuration files

### `.env` (per-developer secrets)

`.env.example` is the source of truth and is heavily commented. The
required minimum is in **Step 3** above.

### `ekg.config.json` (committed, repo-level config)

Three sections:

1. **`repos[]`** — declarative repo list (used by the legacy CLI / future
   declarative ingest). For pure MCP-driven workflows leave it empty or with
   one example.
2. **`ignoreDirs[]` / `supportedExtensions[]`** — overrides for
   `FileScanner`. Comment them out to use the defaults from
   `packages/shared/src/constants.ts`.
3. **`mcpAdapters[]`** — Phase 6 external adapters. Each entry needs:
   - `id` — must match a registered factory (`datadog`, `atlassian`,
     `mixpanel`, `loki`, …).
   - `enabled: true` to activate (default false).
   - `command` + `args[]` for stdio adapters that spawn an upstream MCP
     server.
   - `env` map referencing `${VAR}`-style placeholders that are pulled from
     `.env` at startup.
   - `serviceMapping`: `"auto"` (EKG service name = external tag) or an
     object like `{ field: "app", pattern: "{service}" }`.
   - `capabilities[]` — what the agent's capability router will route to
     this adapter (`metrics`, `traces`, `errors`, `logs`, `docs`, `tickets`,
     `usage`, `alarms`).
   - Optional `config.tools.*` overrides if the upstream MCP server uses
     different tool names than the adapter expects.

The committed `ekg.config.json` ships with **Datadog, Atlassian, Mixpanel,
Loki** entries — all `enabled: false`. Flip the ones you need.

---

## Operations

### Performance

- **Worker-thread pool** for ts-morph parsing — sized at `cpus - 1` by
  default, falls back to in-process parsing if `dist/` not built.
- **UNWIND-batched** Neo4j writes (batch size 500) — one Cypher round-trip
  per node label / relationship type.
- **Repo-scoped orphan cleanup** during incremental ingest — never a full
  graph scan.
- **Embeddings**: opt-in. Stored in a sibling SQLite at
  `data/ekg-embeddings.db` so wiping it doesn't affect ingestion bookkeeping.
- **BM25 (FTS5)**: always-on, sibling SQLite at `data/ekg-search.db`.

### Concurrency tuning

- `BULK_CONCURRENCY=5` is the default for healthy laptops.
- If you see `"transaction has been terminated"` or `Unable to acquire
  lock for resource: NODE_RELATIONSHIP_GROUP_DELETE` errors in the DLQ,
  drop to `BULK_CONCURRENCY=2`. Single-process Neo4j Community Edition
  does not parallelise writes well past that point.
- Concurrency above `5` is rarely worth it. Past `8`, transaction timeouts
  dominate.

### Graceful shutdown

On `SIGINT` / `SIGTERM` the MCP server:

1. Marks any in-flight `bulk_ingest` as aborted so the queue stops
   dispatching new repos.
2. Awaits the currently-running ingestions (up to 30 s) so no UNWIND merge
   is interrupted mid-batch.
3. Terminates the ts-morph worker pool, then closes SQLite + Neo4j.

### Schema-drift detection

After each incremental ingest, `SchemaDriftDetector` checks for new
`Migration` / `Table` / `Column` nodes. If any are present, all
`Function`/`Doc`/`Table` embeddings for that repo are invalidated so the
next embed pass refreshes them with the new schema context.

### Metrics

Exposed via `ekg://metrics` (resource) and `get_metrics` (tool):

| Metric | Type | Notes |
|---|---|---|
| `ingest.success` / `ingest.failed` | counter | Per-repo ingestion outcomes |
| `ingest.files_processed` | counter | Files actually parsed |
| `ingest.duration_ms{status}` | histogram | p50/p95/p99 over a 1024-sample reservoir |
| `graph.nodes.merged` / `graph.edges.merged` | counter | Total batched MERGEs |
| `parser.pool.size` | gauge | Current ts-morph worker count |
| `graph.nodes` / `graph.edges` | gauge | Live counts (one Neo4j query) |

---

## Tech stack

| Component | Technology |
|---|---|
| Runtime | Node.js (TypeScript, strict mode, ESM) |
| Graph DB | Neo4j 5 Community Edition |
| Metadata DB | SQLite (better-sqlite3, WAL mode) |
| AST parser (TS/JS) | ts-morph in worker_threads pool |
| Multi-language extractor | regex per language (Java/Go/Python/Rust/Ruby/PHP/C#/Kotlin/Scala/Swift/C/C++) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Git | simple-git (shallow clone, blob filter, retry-on-HEAD-mismatch) |
| GitLab API | Native fetch (v4 REST) |
| Logging | Pino (structured JSON, dual transport, credential redaction) |
| Validation | Zod (env config + every MCP tool input) |
| Embeddings | Ollama / OpenAI / Voyage |
| LLM router + agent | Anthropic / OpenAI / Ollama |
| Reranker (optional) | Cohere / Voyage |
| Testing | Vitest (~80 test files, ~560 tests) |

---

## Development

```bash
# Run the full test suite
npm test

# Type-check the entire monorepo
npm run typecheck

# Build everything (composite tsbuild)
npm run build

# Clean dist/ in every workspace
npm run clean

# Dev mode (tsx, no rebuild needed)
npm run dev:mcp
npm run dev:worker
```

### Repo layout

```
CodeSage/
├── apps/
│   ├── mcp-server/      # MCP stdio server
│   ├── worker/          # Ingestion pipeline + drift + service resolver
│   └── webhook-server/  # GitLab push → incremental ingest
├── packages/
│   ├── shared/          # Types, schemas, constants, logger
│   ├── parser/          # ts-morph + multi-lang + GitLab/GitHub clients
│   ├── extractor/       # All extractors (schema, symbols, OpenAPI, helm, …)
│   ├── graph/           # Neo4j client + UNWIND repo + queries + cache
│   ├── storage/         # SQLite repos
│   ├── embeddings/      # Provider factories
│   ├── search/          # Hybrid + rerankers + graph expansion
│   ├── router/          # LLM router + classifier + plan executor
│   ├── agent/           # Tool-using agent + prompts + answer contract
│   ├── observability/   # Trace / cost / budget / feedback
│   ├── eval/            # RAGAS-style runner + seed cases
│   ├── advanced/        # Flow synthesis, snapshots, runtime registry
│   └── adapters/        # Datadog / Atlassian / Mixpanel / Loki + bootstrap
├── infra/
│   └── docker-compose.yml   # Neo4j Community
├── data/                # gitignored — clones, SQLite, logs
├── ekg.config.json      # repo-level config (committed)
├── .env / .env.example  # secrets (gitignored / committed-as-template)
├── llmPLAN.md           # roadmap
└── README.md            # ← you're here
```

### Adding a new extractor

1. Create `packages/extractor/src/<name>.extractor.ts`.
2. Implement `static handles(content)` and `extract(content, relPath, repoUrl)`
   returning `{ tables, columns, relations }` (or whatever shape your nodes
   need).
3. Wire it into `extraction.pipeline.ts` — usually as a side-pass under
   `extractOrmSchemas` or in a dedicated step.
4. Add a unit test under `packages/extractor/test/unit/`.

### Adding a new MCP adapter

1. Create `packages/adapters/src/<vendor>/<vendor>.adapter.ts`
   implementing the `McpAdapter` interface (capabilities + `connect()` /
   `disconnect()` / capability-specific methods).
2. Add a factory `createXyzAdapter(ctx)` and export both from
   `packages/adapters/src/index.ts`.
3. Register the factory in `packages/adapters/src/bootstrap.ts`
   (`DEFAULT_FACTORIES`).
4. Add an entry to `ekg.config.json/mcpAdapters[]` (default `enabled: false`).
5. Document the env vars in `.env.example`.

For adapters that wrap an upstream stdio MCP server, use the existing
`McpStdioClient` from `packages/adapters/src/mcp.client.ts` — it spawns the
child, handles JSON-RPC, normalises tool-call results.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Property values can only be of primitive types or arrays thereof` | An extractor put a nested object on a graph node property | Stringify the value before assigning. The Markdown headings + OpenAPI `$ref` extractors hit this; check `markdown.extractor.ts` / `openapi.extractor.ts` for the pattern. |
| `couldn't find remote ref main` in DLQ | Repo's default branch is master/develop/etc | The cloner falls back to `git ls-remote --symref origin HEAD` automatically (since the latest build). Re-run `retry_dlq` on a freshly-restarted MCP server. |
| `transaction has been terminated` in DLQ | Neo4j tx timeout under bulk-ingest concurrency | Drop `BULK_CONCURRENCY` to `2` and retry. |
| `Unable to acquire lock for resource: NODE_RELATIONSHIP_GROUP_DELETE` | Two ingestions trying to touch the same shared node (Database, Topic) | Same fix — lower concurrency. |
| MCP server keeps spawning extra processes | Each Claude Code workspace spawns its own MCP server. Multiple `/mcp` reconnects can stack them. | `ps -ef \| grep mcp-server`, kill all, then a single `/mcp` reconnect. |
| Stale `get_ingestion_status` snapshots | The bulk-job state row in SQLite updates less often than per-repo log lines | Tail `data/ekg.log` for ground truth (`grep "Writing graph" data/ekg.log`). |
| `EKG_AGENT_PROVIDER=anthropic requires ANTHROPIC_API_KEY` | Provider key set as literal `...` or empty | Replace with the real key, or comment the line out and switch to `ollama`. |
| Embeddings silently failing | Ollama not running or model not pulled | `curl localhost:11434/api/tags \| grep nomic-embed-text` — if missing, `ollama pull nomic-embed-text`. Or switch `EKG_EMBEDDING_PROVIDER=openai`. |
| Adapter `enabled: true` but tool calls fail | Upstream MCP server not installed or token wrong | `npx -y` will fetch on first run; check the spawned process logs. Verify token via the vendor's API directly. |

---

## Roadmap

See `llmPLAN.md` for the full multi-phase plan. Current state:

- **Phase 1 (deterministic graph)** — complete: schema extractors for all
  major TS/Python/Go ORMs + raw SQL + Liquibase, multi-lang Kafka, Helm/K8s
  configs, CODEOWNERS, optional git history.
- **Phase 2 (retrieval)** — complete: embeddings, BM25 (FTS5), hybrid +
  RRF, optional rerankers, query planner.
- **Phase 3 (agent)** — complete: tool-using agent, citations, refusal on
  empty retrieval.
- **Phase 4 (eval / observability / freshness)** — runner + seed cases
  shipped; full ~200-question gold set is a human task. Webhook-driven
  incremental ingest works.
- **Phase 5 (advanced)** — flow synthesis, snapshots, change-impact v2,
  runtime evidence registry.
- **Phase 6 (external adapters)** — Datadog implemented end-to-end;
  Atlassian, Mixpanel, Loki ship as stdio-wrapper adapters that spawn
  upstream community MCP servers (configurable in `ekg.config.json`).

---

## License

MIT
