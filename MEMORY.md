# Memory
- A living document to maintain our "institutional memory" across many llm chat sessions and long spans of time
  - Write down lessons, gotchas, surprises -- anything non-obvious that burned us once will likely burn us again, if we don't write it down so future llm sessions can recall it
  - But first, always prefer code comments when appropriate, but for anything that doesn't naturally fit into the code, write it down here
- Style and formatting:
  - Include a date prefix, and order new (top) to old (bottom)
  - Keep each item concise and punchy, to avoid token bloat
  - When appropriate, remove items that are totally defunct, to reduce noise. But in doubt, leave it.

## Last codebase review
- 2026-02-28 32452fe

## Memory log
- [2026-02-26] OpenCode internals (reference)
  - TypeScript, runs on Bun, Hono web framework
  - Repo: `anomalyco/opencode`
  - Per-directory state isolation via `AsyncLocalStorage`
  - Key endpoints: `POST /session/:id/prompt_async`, `GET /event` (SSE), session CRUD, abort, fork, diff
  - JS SDK (`@opencode-ai/sdk`) exists but just spawns a child process
  - Auth middleware is first in Hono chain — all routes behind it, architecturally safe
  - Catch-all route proxies unmatched paths to `app.opencode.ai` (how built-in web UI works)
  - Built-in web UI uses `location.origin` as API base URL (`packages/app/src/entry.tsx`)
    - So it only works when served from the same origin as the API (no path prefix support)
