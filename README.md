# ocweb
Personal "Claude Code Web" alternative: opencode + OpenRouter, deployed for mobile/async use.

- See [AGENTS.md](AGENTS.md) for agent instructions

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
POST   /admin/repos/clone     {repo: "owner/name"}
DELETE /admin/repos/{repo}
GET    /admin/repos

POST   /admin/worktrees       {repo, sessionId}
DELETE /admin/worktrees/{id}
GET    /admin/worktrees

GET    /admin/disk
POST   /admin/gc
GET    /admin/processes        (orphan detection)
POST   /admin/processes/{pid}/kill
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

### Custom frontend
- Mobile-friendly responsive web app
- Talks to opencode REST + SSE API at `/` (same origin, no prefix)
- Talks to sidecar API for git/resource management at `/admin/*`
- Concurrency: multiple tabs/reconnects → broadcast pattern, last-write-wins on input

## Implementation notes

### Container layout
Single Dockerfile, all files under `/opt/ocweb/`. Three processes managed by `run`:
1. **opencode serve** on `:4096` (`--hostname 0.0.0.0`, `OPENCODE_SERVER_PASSWORD` unset)
2. **Sidecar** (Python/FastAPI/uvicorn) on `:4097`
3. **Caddy** on `:8080` (foreground via `exec`; Fly terminates TLS at edge)

opencode and sidecar are backgrounded. `run` waits for opencode's `/health` before starting Caddy.

### Caddy routing
- `/admin/*` → sidecar `:4097`
- `/*` → static file if it exists in our frontend dir, otherwise → opencode `:4096`

This lets `/` serve our `index.html`, while `/session/*`, `/event`, etc. pass through to
the opencode API. The built-in opencode web UI also works: point `app.opencode.ai` at this
server and its API calls reach opencode directly.

### Startup timeline (~23s)
1. Fly starts VM, mounts volume, runs `/opt/ocweb/run`
2. `run` hashes `CADDY_AUTH_PASSWORD` via `caddy hash-password` (~1-2s)
3. opencode + sidecar start in background
4. Sidecar ready on `:4097` (~18s)
5. opencode does SQLite migration on first boot, then ready on `:4096` (~20s)
6. `run` health-check loop detects opencode, starts Caddy on `:8080` (~22s)
7. `fly deploy` always warns "not listening on :8080" because it checks before startup finishes — harmless

### Secrets (set via `fly secrets set`)
- `CADDY_AUTH_USER` — HTTP basic auth username
- `CADDY_AUTH_PASSWORD` — plaintext, hashed at startup by `run`
- `GITHUB_TOKEN` — GitHub PAT for private repo access
- `OPENROUTER_API_KEY` — (or whichever provider env opencode needs)

### Non-secret env (in fly.toml `[env]`)
- `GITHUB_USER` — GitHub username for repo lookups
- `OPENCODE_HOME` — `/vol/opencode-state` (SQLite on persistent volume)

### Sidecar implementation
- Python + FastAPI, chosen for speed of development
- Bare clones in `/vol/projects/repos/`, worktrees in `/vol/projects/worktrees/`
- Repo dirs use `owner__name` convention (slash-safe)
- Worktree dirs use `owner__name__sessionId`
- FastAPI auto-docs at `/admin/docs`

## Deploy

```bash
cd backend/

# First time: create app + volume
fly apps create ocweb-jdanbrown --org jdanbrown
fly volumes create ocweb_vol --app ocweb-jdanbrown --region sjc --size 10

# Set secrets
fly secrets set --app ocweb-jdanbrown CADDY_AUTH_USER=... CADDY_AUTH_PASSWORD=... GITHUB_TOKEN=... OPENROUTER_API_KEY=...

# Deploy
fly deploy
```

## OpenCode internals (reference)
- TypeScript, runs on Bun, Hono web framework
- Repo: `anomalyco/opencode`
- Per-directory state isolation via `AsyncLocalStorage`
- Key endpoints: `POST /session/:id/prompt_async`, `GET /event` (SSE), session CRUD, abort, fork, diff
- JS SDK (`@opencode-ai/sdk`) exists but just spawns a child process
- Auth middleware is first in Hono chain — all routes behind it, architecturally safe
- Catch-all route proxies unmatched paths to `app.opencode.ai` (how built-in web UI works)
- Built-in web UI uses `location.origin` as API base URL (`packages/app/src/entry.tsx`)
  - So it only works when served from the same origin as the API (no path prefix support)
  - Our frontend will use the SDK with `baseUrl: "/oc"` instead
- The npm package uses a `#!/usr/bin/env node` shebang, so `node` must exist on PATH
  - We symlink bun as node in the Dockerfile
