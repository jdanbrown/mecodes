# Memory
- A living document to maintain our "institutional memory" across many llm chat sessions and long spans of time
  - Write down lessons, gotchas, surprises — anything non-obvious that burned us once will likely burn us again, if we don't write it down so future llm sessions can recall it
  - But first, always prefer code comments when appropriate, but for anything that doesn't naturally fit into the code, write it down here
- Style and formatting:
  - Include a date prefix, and order new (top) to old (bottom)
  - Keep each item concise and punchy, to avoid token bloat
  - When appropriate, remove items that are totally defunct, to reduce noise. But in doubt, leave it.

## Last codebase review
- 2026-02-28 32452fe

## Memory log
- [2026-03-01] OpenCode SSE event format (v2)
  - All events are unnamed SSE messages (`onmessage`), no `event:` field — don't use `addEventListener`
  - Format: `{ type: "event.type", properties: { ... } }`
  - Key events: `session.created/updated` (props.info), `session.status` (props.sessionID, props.status.generating), `session.error` (props.sessionID, props.error), `message.updated` (props.info), `message.part.updated` (props.part), `message.part.delta` (props.sessionID/messageID/partID/field/delta)
  - Messages via `GET /session/:id/message` return v2 format: `[{ info: {id, role, ...}, parts: [...] }]`
  - Part types: `text`, `reasoning`, `tool` (with state: pending/running/completed/error), `step-start`, `step-finish`, `snapshot`, `patch`, `subtask`, `compaction`
  - Errors come through two paths: `session.error` event AND `message.updated` with `info.error` on assistant message — dedup or pick one
- [2026-03-01] OpenCode serve gotchas
  - `--print-logs` required to see logs on stderr (otherwise logs go to `~/.local/share/opencode/log/` only)
  - Treats CWD as project root, tries git operations (snapshots) — fails with "No such file or directory" if CWD has no `.git` (e.g. `/opt/dancodes` where `.git` is in `.dockerignore`)
  - `HOME` is used as starting dir for opencode web UI's "Open project" folder picker — set it to `/vol/projects/worktrees` so worktrees are discoverable
- [2026-03-01] Frontend rendering pitfall
  - Don't DOM-append elements (e.g. error messages) into a container that gets rebuilt via `innerHTML =` on the next event — they get wiped. Store everything in state and render from state.
- [2026-02-28] Replaced bun with real node in Dockerfile
  - Previously: bun installed, `ln -s bun node` to satisfy opencode's `#!/usr/bin/env node` shebang
  - Now: real node via nodesource apt repo, no bun — same `node`/`npm`/`npx` commands in local dev and prod
  - Frontend tooling: biome (lint + format) via `npm install`, checked by `dev/check`
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
