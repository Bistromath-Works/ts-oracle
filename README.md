# ts-trainer MCP Server

An MCP server that gives the Foreman crew retrieval-grounded TypeScript quality standards. The Orchestrator calls `ts_retrieve` to get real exemplar code from 4 curated repos before writing annotated edits.

## Designed for use with Foreman

This server is a companion to the [Foreman](https://github.com/Bistromath-Works/claude-dev-commands) multi-agent crew. It is not a standalone tool.

When Foreman's Orchestrator completes a TypeScript build task, it automatically invokes `/ts-review` on any TypeScript files before passing work to the Dissenter. The `/ts-review` skill calls `ts_retrieve` here to ground its edits in real exemplar code rather than pattern-matching from training data alone.

If you are not running Foreman, this server has no built-in trigger — you would need to call the MCP tools manually or wire them into your own workflow.

## What's in the corpus

2,147 chunks indexed across:
- `sindresorhus/type-fest` — type utilities, conditional types, mapped types
- `colinhacks/zod` — schema design, API surface, inference
- `trpc/trpc` — end-to-end type safety, router contracts
- `microsoft/TypeScript` (`src/compiler/types.ts`) — type modeling at scale

The corpus is bundled as `corpus.db` (SQLite + sqlite-vec). No external database required.

## Prerequisites

- Docker (for running the server)
- An embedding model — pick one:

### Option A: Local Ollama (no API costs, no rate limits)

Install [Ollama](https://ollama.com) and pull the model:

```bash
ollama pull nomic-embed-text-v2-moe
```

Ollama must be running whenever the server is running.

### Option B: Hosted API (no local model required)

Use any OpenAI-compatible embedding API. Set `OLLAMA_BASE_URL` and `EMBEDDING_API_KEY` in `.env.local`. Gemini's free tier (1,000 queries/day) is sufficient for query-time use.

## Running the server

```bash
docker compose up -d
```

The server starts on port 3001 and restarts automatically with Docker.

To stop:

```bash
docker compose down
```

If using Option B (hosted API), create `.env.local` first:

```
OLLAMA_BASE_URL=https://your-embedding-api.com
EMBEDDING_API_KEY=your-key
```

Then mount it via compose or pass it as an env var.

## Register with Claude Code

```bash
claude mcp add ts-trainer -s user --transport http http://localhost:3001
```

Then add tool permissions to `~/.claude/settings.json`:

```json
"mcp__ts-trainer__ts_retrieve",
"mcp__ts-trainer__ts_retrieve_judgment",
"mcp__ts-trainer__ts_store_judgment"
```

## Tools

| Tool | Purpose |
|---|---|
| `ts_retrieve(query, pattern_type?, match_count?)` | Retrieve exemplar code. Used by `/ts-review`. |
| `ts_retrieve_judgment(query, match_count?)` | Retrieve past Foreman-Worker judgment conversations. |
| `ts_store_judgment(task_desc, worker_code, edits, pattern_tags)` | Store a completed review. Grows the corpus over time. |

## Re-indexing the corpus

The bundled `corpus.db` is ready to use. If you want to re-index from source (e.g. to add repos or update to newer source versions), you need Ollama running locally:

```bash
npm run index-corpus
```

This clones the 4 repos, chunks them, embeds via Ollama, and writes `corpus.db`. Takes ~10 minutes. Re-running is safe — existing rows are replaced.

## Development

To run without Docker:

```bash
npm run dev
```

Ollama must be running locally.
