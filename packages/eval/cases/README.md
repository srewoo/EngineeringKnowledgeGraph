# EKG Eval Cases

This directory contains evaluation question sets used by the eval runner
(`@ekg/eval`). Each file is a JSON array conforming to `evalCasesSchema`
in `packages/eval/src/cases.loader.ts`.

## Files

- **`seed.cases.json`** — 20 hand-written synthetic cases covering all 9
  question classes (topology, schema, code, flow, api, ownership, config,
  ops, history). Citations are illustrative — they reference example node
  ids that may or may not exist in any specific repo. Use this set to
  exercise the runner end-to-end and as a template for the real gold set.

- **`gold.cases.json`** *(not yet committed)* — the real ~200-question gold
  set. This must be assembled from real engineer questions with expert-
  authored citations. Populate it by:
  1. Sampling Slack questions / paste-ins / "ask me anything" sessions.
  2. Resolving each to concrete graph node ids by running queries against
     a populated EKG instance.
  3. Reviewing each case with the team that owns the relevant service.
  4. Targeting ~22 cases per question class for balanced coverage.

## Citation format

`Label:identifier` — e.g.

- `Service:user-service`
- `API:POST /coaching/sessions`
- `Table:users`
- `Column:users.deleted_at`
- `Function:calculateProficiencyScore`
- `Topic:audit.log`
- `Migration:V42__add_account_kind`
- `Team:revenue`
- `ConfigKey:SNOWFLAKE_PASSWORD`
- `SecretRef:vault/snowflake`
- `Commit:abc123`
- `File:user-service/src/middleware/auth.ts`

## Running the eval

```
node apps/mcp-server/dist/index.js
# In MCP client, call:
eval_run(casesFile: "packages/eval/cases/seed.cases.json")
```

Threshold gates for the regression suite live in CI; the seed set is too
small to set meaningful gates against.
