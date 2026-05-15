# @ekg/agent

Phase 3 Agentic Q&A layer. Wraps the deterministic EKG retrieval (Phase 1
graph + Phase 2 hybrid + Phase 2.3 router) as **tools** that an LLM can call
in a bounded loop, then validates the final answer against a strict citation
contract.

## Two ways to drive the loop

EKG supports both modes — they answer different deployment questions.

### A. External MCP client drives the loop (no key, no agent code)

Every Phase 2.x retrieval tool is already exposed via MCP. Any MCP-aware LLM
client (Claude Code / Cursor / Cline / IDE plugins) can connect to the EKG
server and call `ask_question`, `search_codebase`, `cypher_query`, etc.
itself. In that mode the **client's** LLM runs the tool-loop. EKG is purely a
tool provider — no API key on the EKG side, no agent code path executed.

### B. EKG runs the loop itself (`@ekg/agent`)

This package. EKG is configured with an LLM provider (OpenAI / Anthropic /
Ollama), and the new `answer_question` MCP tool runs a self-contained
tool-loop end-to-end on the server. Useful when:

- The caller is **not** an LLM client (CI, Slack bot, scripting).
- You want a single deterministic refusal contract, regardless of the
  upstream LLM's behaviour.
- You want consistent token-budget and tool-call caps enforced server-side.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `EKG_AGENT_ENABLED` | `false` | Master switch. Must be `true` to register `answer_question`. |
| `EKG_AGENT_PROVIDER` | `ollama` | `openai` \| `anthropic` \| `ollama` |
| `EKG_AGENT_MODEL` | provider default | Model override (e.g. `claude-3-5-sonnet-latest`, `gpt-4o-mini`, `llama3.1:8b`). |
| `EKG_AGENT_MAX_TOKENS` | `8000` | Total input+output token budget per question. |
| `OPENAI_API_KEY` | – | Required when provider=openai. |
| `ANTHROPIC_API_KEY` | – | Required when provider=anthropic. |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL. |

## Hard limits

- Tool iterations capped at 5.
- Read-only Cypher only (mutations are rejected at the tool layer).
- `code.read` and `git.blame` refuse paths outside `data/repos/`.
- Final answer must validate against `answerSchema` AND every citation must
  reference an ID/path returned by an earlier tool call. Hallucinated
  citations → refuse.

## What this package does NOT do

- It does not stream. The `complete()` interface is request/response.
- It does not run tool calls in parallel within a turn. Sequential only.
- It does not persist conversation state across questions.
