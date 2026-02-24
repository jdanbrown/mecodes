# ocweb Design
Personal "Claude Code Web" alternative: opencode + OpenRouter, deployed for mobile/async use.

## Motivation
- The mobile/async UX of Claude Code Web is great (fire-and-forget from phone)
- But: usage limits, flakiness, slowness on the $20/mo plan
- OpenCode + OpenRouter on laptop is already great — extend it to mobile

## Architecture
```
Phone → Caddy (TLS + basic auth) → opencode serve :4096
                                        ↓
                                    /vol/projects/  (git clones + worktrees)
                                    /vol/opencode-state/  (SQLite)
```

Plus a small **sidecar** for git lifecycle + resource management.

### Why this is so thin
A single `opencode serve` process already handles:
- Multiple projects natively (via `directory` query param / `x-opencode-directory` header)
- Full REST + SSE API (sessions, prompts, streaming, abort, fork, diff, health)
- Session persistence in SQLite (survives restarts)
- OpenAPI spec auto-generated from Zod schemas

So the frontend can talk to the opencode API directly. No orchestrator/proxy needed.

### Auth: Caddy layer only
- Caddy handles TLS + HTTP Basic Auth (bcrypt-hashed passwords)
- `OPENCODE_SERVER_PASSWORD` left **unset** on opencode serve — Caddy is the auth wall
- Rationale: decouples security boundary from opencode's implementation, immune to upstream auth changes
- Can add rate limiting, IP allowlisting, Tailscale/WireGuard at the Caddy layer later

### Deploys: no drain needed
- OpenCode sessions persist in SQLite, survive restarts
- Truncated LLM responses recovered by prompting "keep going"
- Fly replaces the whole VM on deploy, so orphaned child procs die with it
- Not worth engineering graceful drain for personal use

## Sidecar
A small service for things opencode doesn't expose.

### Git management
- Hardcoded GitHub username, API token injected via secrets
- List user's repos via GitHub API for the frontend to pick from
- **Clone cache**: clone repo on first use, reuse across sessions
- **Worktree per session**: each chat gets a git worktree keyed by opencode session ID
- On new chat: clone if needed → create worktree → tell opencode to work in that dir

### Resource dashboard
Frontend page showing:
- Cloned repos (with delete)
- Worktrees / session dirs (with delete)
- Disk usage
- Running opencode sessions (via opencode API)
- **Orphaned processes**: `ps` for PPID=1, filter known services, surface with kill buttons

### Sidecar API (draft)
```
POST   /mgmt/repos/clone     {repo: "owner/name"}
DELETE /mgmt/repos/{repo}
GET    /mgmt/repos

POST   /mgmt/worktrees       {repo, sessionId}
DELETE /mgmt/worktrees/{id}
GET    /mgmt/worktrees

GET    /mgmt/disk
POST   /mgmt/gc
GET    /mgmt/processes        (orphan detection)
POST   /mgmt/processes/{pid}/kill
```

### Process cleanup notes
- Always use the opencode API to stop sessions (`POST /session/:id/abort`, `POST /instance/dispose`), never raw `kill`
- Session abort triggers `Shell.killTree()` → process-group-level SIGTERM → SIGKILL (clean)
- If opencode serve itself is killed, child procs may orphan (spawned with `detached: true`, no signal handlers in headless mode)
- On Fly this is fine since deploys replace the VM

## Hosting: Fly.io
- 1 machine + 1 volume, estimated ~$5-15/mo
- **`auto_stop_machines = "off"`** — critical, otherwise Fly kills the machine mid-task
- Volume is single-attach (fine for 1 machine)
- Health check endpoint on sidecar/caddy, not on opencode child processes

## Frontend

### Strategy: web-first, iOS-native later
- Web frontend first because LLM coding tools close the loop on web easily
- iOS native second, once the API and backend are proven
- Even if web frontend is throwaway, it smooths out API/backend issues

### Prototype 0: opencode's built-in web UI
- `opencode web` serves a frontend from `app.opencode.ai` (via catch-all proxy route)
- Deploy Fly + Caddy + opencode serve, point phone at it, see how far it gets
- Validates the backend architecture before writing any custom code

### Custom frontend (later)
- Mobile-friendly responsive web app
- Talks to opencode REST + SSE API directly (through Caddy)
- Talks to sidecar API for git/resource management
- Concurrency: multiple tabs/reconnects → broadcast pattern, last-write-wins on input

## Implementation notes

### Container layout
Single Dockerfile, three processes managed by `entrypoint.sh`:
1. **Caddy** on `:8080` (Fly terminates TLS at edge, so no auto-HTTPS needed)
2. **opencode serve** on `:4096` (`--hostname 0.0.0.0`, `OPENCODE_SERVER_PASSWORD` unset)
3. **Sidecar** (Python/FastAPI/uvicorn) on `:4097`

Caddy is the foreground process (`exec`); opencode and sidecar are backgrounded.

### Caddy routing
- `/mgmt/*` → sidecar `:4097`
- Everything else → opencode `:4096` (includes the catch-all `app.opencode.ai` web UI proxy)

### Fly config
- Region `sjc`, `shared-cpu-2x` / 1GB RAM
- Volume `ocweb_vol` at `/vol`
- `OPENCODE_HOME=/vol/opencode-state` — puts SQLite on persistent volume
- `auto_stop_machines = "off"`, `min_machines_running = 1`

### Secrets (set via `fly secrets set`)
- `CADDY_AUTH_USER` — HTTP basic auth username
- `CADDY_AUTH_HASH` — bcrypt hash (generate with `caddy hash-password`)
- `GITHUB_USER` — for git clone auth
- `GITHUB_TOKEN` — GitHub PAT for private repo access
- `OPENROUTER_API_KEY` — (or whichever provider env opencode needs)

### Sidecar implementation
- Python + FastAPI, chosen for speed of development
- Bare clones in `/vol/projects/repos/`, worktrees in `/vol/projects/worktrees/`
- Repo dirs use `owner__name` convention (slash-safe)
- Worktree dirs use `owner__name__sessionId`
- FastAPI auto-docs at `/mgmt/docs`

## OpenCode internals (reference)
- TypeScript, runs on Bun, Hono web framework
- Repo: `anomalyco/opencode`
- Per-directory state isolation via `AsyncLocalStorage`
- Key endpoints: `POST /session/:id/prompt_async`, `GET /event` (SSE), session CRUD, abort, fork, diff
- JS SDK (`@opencode-ai/sdk`) exists but just spawns a child process
- Auth middleware is first in Hono chain — all routes behind it, architecturally safe
- One quirk: catch-all route proxies unmatched paths to `app.opencode.ai` (how web UI works)
