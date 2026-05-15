# Engineering Knowledge Graph (EKG)

> A compiler for engineering systems — not a CRUD backend.

EKG is a **local-first, backend-only MCP server** that ingests **multi-language** repositories (TypeScript, JavaScript, Java, Kotlin, Scala, Go, Python, Rust, Ruby, PHP, C#, C/C++), extracts structural relationships using deterministic AST + regex analysis, stores them in a Neo4j knowledge graph, and exposes everything via MCP tools for AI agents like Claude.

## Why This Exists

Most "AI knowledge systems" throw embeddings and LLMs at code understanding. EKG takes a different approach:

- **Deterministic extraction** — AST-based parsing (ts-morph for TS/JS) + regex extractors per language, not LLM inference
- **Multi-language** — Java/Kotlin/Scala, Go, Python, Rust, Ruby, PHP, C#, C/C++ alongside TS/JS
- **Graph-first** — relationships are precomputed at ingestion time, not discovered at query time
- **Schema-last** — raw triples first, inferred nodes second
- **Local-first** — runs entirely on your machine at ₹0 cost
- **MCP-native** — designed to be used by AI agents, not humans directly
- **Source-only** — binaries (`.jar/.exe/.dll/.so/.dmg`), media, fonts, lockfiles, and files >2 MB are skipped automatically

## Quick Start

### Prerequisites

- Node.js ≥ 20
- Docker (for Neo4j)

### 1. Install dependencies

```bash
npm install
```

### 2. Start Neo4j

```bash
cd infra && docker compose up -d
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `ekg-local-dev` | Neo4j password |
| `GIT_TOKEN` | _(empty)_ | GitLab/GitHub token for private repos |
| `GITLAB_URL` | `https://gitlab.com` | Your GitLab instance URL |
| `GITLAB_GROUP_IDS` | _(empty)_ | Comma-separated GitLab group IDs for bulk discovery |
| `MAX_REPO_SIZE_MB` | `1024` | Skip repos larger than this (in MB) |
| `BULK_CONCURRENCY` | `5` | Parallel repo ingestion limit (1-10) |
| `LOG_LEVEL` | `info` | Logging level |
| `DATA_DIR` | `./data` | Local data directory |

### 4. Build

```bash
npm run build
```

### 5. Start MCP Server

```bash
npm run dev:mcp
```

### 6. Connect to an MCP client

#### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ekg": {
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/CodeSage",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "ekg-local-dev",
        "GIT_TOKEN": "your-gitlab-token",
        "GITLAB_URL": "https://gitlab.com",
        "MAX_REPO_SIZE_MB": "1024",
        "DATA_DIR": "./data"
      }
    }
  }
}
```

#### Claude Code (CLI)

Add to your project's `.mcp.json` or `~/.claude/claude_code_config.json`:

```json
{
  "mcpServers": {
    "ekg": {
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/CodeSage",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "ekg-local-dev",
        "GIT_TOKEN": "your-gitlab-token",
        "GITLAB_URL": "https://gitlab.com",
        "MAX_REPO_SIZE_MB": "1024",
        "DATA_DIR": "./data"
      }
    }
  }
}
```

> **Tip:** You can also register EKG as a global MCP server in Claude Code by running:
> ```bash
> claude mcp add ekg node apps/mcp-server/dist/index.js
> ```

## Usage Workflows

### Ingest a single repo

```
→ ingest_repo(url: "https://gitlab.com/org/my-service", branch: "main")
```

### Ingest your entire org (400+ repos)

```
Step 1: Preview what will be ingested
→ discover_repos(groupIds: "12345")

Step 2: Bulk ingest (repos > 1GB are auto-skipped)
→ bulk_ingest(groupIds: "12345")

Step 3: Link cross-service HTTP calls
→ resolve_services()
```

### Re-run bulk ingest (smart incremental)

```
→ bulk_ingest(groupIds: "12345")
  ✓ Unchanged repos: SKIPPED (0 work)
  ✓ Repos with <100 changed files: INCREMENTAL (only re-parses changed files)
  ✓ Repos with >100 changed files: FULL re-extraction
```

### Query the knowledge graph

```
→ list_services()                    # What services exist?
→ list_databases()                   # What databases are used?
→ get_service_summary(service: "user-service")   # Full overview
→ get_dependencies(service: "user-service", depth: 3)  # Transitive deps
→ analyze_impact(node: "Couchbase", depth: 4)    # What breaks if Couchbase changes?
→ search_codebase(query: "auth", type: "API")    # Find auth APIs
→ get_api_map(service: "user-service")           # All endpoints
→ get_ingestion_status(repo: "https://gitlab.com/org/my-service")  # Job status
```

### Ad-hoc graph queries (read-only)

```
→ cypher_query(
    query: "MATCH (s:Service)-[:USES]->(d:Database) RETURN s.name, d.name",
    maxRows: 50
  )
```
Writes (`CREATE/MERGE/SET/DELETE/REMOVE/DROP/FOREACH/LOAD CSV`) are hard-rejected.
Auto-`LIMIT $maxRows` is appended if missing. Only read-only APOC procs allowed.

### Generate reports (via prompts)

```
→ Use prompt: dependency-report(service: "user-service")
→ Use prompt: impact-assessment(node: "Couchbase", changeType: "db_change")
```

## Architecture

```
Git Repos (400+)
        ↓
GitLab Discovery API ──→ Size Filter (skip > 1GB)
        ↓
Ingestion Workers (concurrent)
        ↓
Extraction Engine
   ├── TypeScriptParserPool    — worker_threads × (cpus-1) running ts-morph
   ├── MultiLanguageParser     — regex (Java/Go/Python/Rust/...)
   ├── ApiSchemaScanner        — OpenAPI / .proto / GraphQL
   ├── ConfigScanner           — .env / JSON / docker-compose
   └── MetadataScanner         — CODEOWNERS + git log (per-file lastChangedAt)
        ↓
Graph Builder (idempotent MERGE)
        ↓
Service Resolver (cross-repo URL linking)
        ↓
Storage Layer
   ├── Graph DB (Neo4j)
   └── Metadata DB (SQLite)
        ↓
Query Engine + Cache
        ↓
MCP Server (stdio)
        ↓
AI Agents (Claude / Cursor)
```

## MCP Interface

### Tools (15)

| Tool | Description |
|---|---|
| `ingest_repo` | Clone and ingest a single repo |
| `discover_repos` | Preview all repos in GitLab groups (with sizes) |
| `bulk_ingest` | Ingest all repos from GitLab/GitHub groups (rate-limited, concurrency + size limits) |
| `resolve_services` | Link HTTP call URLs to service nodes (K8s DNS / env-substituted URLs aware) |
| `list_services` | List all discovered services |
| `list_databases` | List all discovered databases |
| `search_codebase` | Scored search across the graph (multi-label filter, Owner/Team types) |
| `get_dependencies` | Direct + transitive dependency traversal (with `excludeNpm` / `excludeLabels`) |
| `analyze_impact` | Impact analysis — who breaks if X changes? (`onlyServices`, `excludeNpm`, `excludeLabels`) |
| `get_service_summary` | Full service overview (APIs, DBs, deps) |
| `get_api_map` | List all API endpoints, optionally by service |
| `get_ingestion_status` | Check ingestion job status and history (persisted across restarts) |
| `retry_failed` | Re-run all repos whose latest job FAILED |
| `cypher_query` | **Read-only Cypher escape hatch** — rejects writes, auto-LIMITs, 15 s timeout, APOC allowlist |
| `get_metrics` | EKG runtime metrics — ingest counters, parse durations, graph size, query histograms |

### Resources (4)

| Resource | Description |
|---|---|
| `ekg://graph-stats` | Node/edge counts and connection status |
| `ekg://metrics` | Process counters, gauges, and histograms (ingest success/failed, parse durations, pool size) |
| `ekg://services` | List of all services |
| `ekg://databases` | List of all databases |

### Prompts (2)

| Prompt | Description |
|---|---|
| `dependency-report` | Generate a structured dependency report |
| `impact-assessment` | Generate an impact assessment for changes |

## What Gets Extracted

| Category | What's Detected |
|---|---|
| **Imports** | TS/JS ES modules + CommonJS, Java/Kotlin/Scala `import`, Go `import (...)`, Python `import`/`from`, Rust `use`/`extern crate`, Ruby `require`, PHP `use`/`require`, C# `using`, C/C++ `#include` |
| **Exports** | TS/JS functions, classes, variables, interfaces, types, enums (other langs: imports only) |
| **API Routes** | Express / Fastify / Koa / **NestJS decorators (`@Controller`+`@Get/@Post/...`)**, Spring `@GetMapping`/`@RequestMapping`, JAX-RS `@Path`, FastAPI / Flask / Django, Gin / Echo / Fiber / Mux / `net/http`, Actix / Axum, Rails / Laravel, ASP.NET `[HttpGet]` |
| **API Schemas** | **OpenAPI** (`openapi.{yaml,yml,json}`, `swagger.*`), **gRPC** (`.proto` services + RPCs), **GraphQL** (`Query`/`Mutation`/`Subscription` fields) |
| **Databases** | 30+ SDKs cross-language: Couchbase, MongoDB, PostgreSQL, MySQL, Redis, Cassandra, Elasticsearch, Neo4j, MSSQL, Oracle, Hibernate, GORM, SQLx, Diesel, etc. |
| **HTTP Calls** | TS/JS (axios, fetch, got, undici, ky, superagent — template-literal URLs supported), Python (requests, httpx, aiohttp), Go (`net/http`, resty), Java (RestTemplate, OkHttp), Rust (reqwest), Ruby (Net::HTTP, HTTParty), PHP (Guzzle), C# (HttpClient) |
| **Config Files** | `.env`, JSON configs, `docker-compose.yml` DB images |
| **Env Variables** | `process.env.*`, `os.Getenv`, `os.environ`, `System.getenv`, `std::env::var`, `ENV[]`, `Environment.GetEnvironmentVariable` |
| **Ownership** | **CODEOWNERS** parsed from `/`, `.github/`, `.gitlab/`, `docs/` → `Owner` / `Team` nodes with `OWNS` edges to files & services |
| **Repo metadata** | Latest commit SHA + timestamp on the `Repo` node; per-File `sizeBytes`, `loc`, and `lastChangedAt` (single `git log` traversal — bounded at 5 000 commits) |
| **Services** | Config mapping → monorepo `apps/*`/`packages/*` → Dockerfile → fallback |
| **Cross-Service** | URL → service resolution: hostname, **K8s DNS (`*.svc.cluster.local`)**, **env-substituted templates (`${USER_SERVICE_URL}`)**, kebab/underscore variants |

### Skipped (never parsed)

`.jar/.war/.class/.exe/.dll/.so/.dylib/.dmg/.pkg/.zip/.tar/.gz/.png/.jpg/.svg/.pdf/.mp4/.ttf/.woff/.min.js/.min.css/...`, all lockfiles (`package-lock.json`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, ...), and any source file larger than **2 MB**.

## Project Structure

```
CodeSage/
├── apps/
│   ├── mcp-server/          # MCP server (stdio transport)
│   │   └── src/
│   │       ├── tools/        # 15 MCP tool implementations
│   │       ├── resources/    # 4 MCP resources
│   │       ├── prompts/      # 2 MCP prompt templates
│   │       ├── server.ts     # Server factory
│   │       └── index.ts      # Entry point
│   └── worker/               # Ingestion pipeline
│       └── src/
│           ├── repo.cloner.ts
│           ├── ingestion.service.ts    # Smart: skip/incremental/full
│           ├── bulk.ingestion.ts       # Persisted to SQLite, concurrency-controlled
│           └── service.resolver.ts     # Cross-repo URL linking (K8s/env-aware)
├── packages/
│   ├── shared/               # Types, schemas, constants, logger
│   ├── storage/              # SQLite metadata + bulk_jobs
│   ├── graph/                # Neo4j client, UNWIND-batched repository, queries, cache
│   ├── parser/               # ts-morph parser + MultiLanguageParser + ApiSchemaScanner
│   │                         # + ConfigScanner + MetadataScanner + GitLab + GitHub clients
│   └── extractor/            # Relationship extraction, service detection
├── infra/
│   └── docker-compose.yml    # Neo4j Community Edition
├── ekg.config.json           # Repository configuration
└── .env.example              # Environment template
```

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (TypeScript, strict mode) |
| Graph DB | Neo4j 5 Community Edition |
| Metadata DB | SQLite (better-sqlite3) |
| AST Parser | ts-morph (run in a worker_threads pool) |
| Multi-language extractor | regex per language (Java/Go/Python/Rust/Ruby/PHP/C#/C/C++) |
| MCP SDK | @modelcontextprotocol/sdk |
| Git | simple-git |
| GitLab API | Native fetch (v4 REST API) |
| Logging | Pino (structured, with credential redaction) |
| Validation | Zod (all external inputs) |
| Testing | Vitest |

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Clean build artifacts
npm run clean
```

## Operations

### Performance
- **Worker-thread pool** for ts-morph parsing — sized at `cpus - 1` by default. Enabled automatically once the project is built (`npm run build`); falls back to in-process parsing if the worker entry isn't found.
- **UNWIND-batched** Neo4j writes (batch size 500) — one Cypher round-trip per node label and relationship type.
- **Repo-scoped** orphan cleanup, no full-graph scan during incremental ingest.

### Graceful shutdown
On `SIGINT` / `SIGTERM` the MCP server:
1. Marks any in-flight `bulk_ingest` as aborted so the queue stops dispatching new repos.
2. Awaits the currently-running ingestions (up to 30 s) so no UNWIND merge is interrupted mid-batch.
3. Terminates the ts-morph worker pool, then closes SQLite and the Neo4j driver.

### Metrics
Exposed via `ekg://metrics` (resource) and `get_metrics` (tool):

| Metric | Type | Notes |
|---|---|---|
| `ingest.success` / `ingest.failed` | counter | per-repo ingestion outcomes |
| `ingest.files_processed` | counter | files actually parsed |
| `ingest.duration_ms{status}` | histogram | p50/p95/p99 over a 1024-sample reservoir |
| `graph.nodes.merged` / `graph.edges.merged` | counter | total batched MERGEs |
| `parser.pool.size` | gauge | current ts-morph worker count |
| `graph.nodes` / `graph.edges` | gauge | live counts (one Neo4j query) |

## Configuration

Edit `ekg.config.json` to define repositories:

```json
{
  "repos": [
    {
      "url": "https://gitlab.com/your-org/service-a",
      "branch": "main",
      "serviceMappings": {
        "src/": "ServiceA"
      }
    }
  ],
  "ignoreDirs": ["node_modules", "dist", "build", ".git"],
  "supportedExtensions": [".ts", ".tsx", ".js", ".jsx"]
}
```

## License

MIT
