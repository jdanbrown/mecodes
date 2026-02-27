# mecodes
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
- GitHub username hardcoded in fly.toml, API token injected via secrets
- **Clone cache**: bare-clone repo on first use, reuse across sessions
- **Worktree per session**: each chat gets a git worktree keyed by opencode session ID
- On new chat: clone if needed → create worktree → tell opencode to work in that dir

### Resource management
- Cloned repos: list, delete
- Worktrees / session dirs: list, delete
- Disk usage (volume stats)
- Orphan process detection (`ps` for PPID=1, filter known services) + kill
- Garbage collection (prune stale worktrees)

### Not yet implemented
- List user's repos via GitHub API (currently must specify `owner/name` manually)
- Frontend resource dashboard UI (endpoints exist, no UI yet)
- Running opencode sessions in the resource view (query opencode API from frontend)

### Sidecar API
```
POST   /admin/repos/clone                          {repo: "owner/name"}
DELETE /admin/repos/{owner}/{name}
GET    /admin/repos

POST   /admin/worktrees                            {repo, session_id, branch?}
DELETE /admin/worktrees/{owner}/{name}/{session_id}
GET    /admin/worktrees

GET    /admin/disk
POST   /admin/gc
GET    /admin/processes                             (orphan detection)
POST   /admin/processes/{pid}/kill
GET    /admin/health
```

Auto-generated OpenAPI docs at `/admin/docs`.

### Process cleanup notes
- Always use the opencode API to stop sessions (`POST /session/:id/abort`, `POST /instance/dispose`), never raw `kill`
- Session abort triggers `Shell.killTree()` → process-group-level SIGTERM → SIGKILL (clean)
- If opencode serve itself is killed, child procs may orphan (spawned with `detached: true`, no signal handlers in headless mode)
- On Fly this is fine since deploys replace the VM

## Hosting: Fly.io
- 1 machine (`shared-cpu-2x`, 1GB RAM) + 1 volume (10GB), estimated ~$5-15/mo
- **`auto_stop_machines = "off"`** — critical, otherwise Fly kills the machine mid-task
- Volume is single-attach (fine for 1 machine)
- Health check: Fly polls `/admin/health` (sidecar), which checks opencode liveness internally
  - Unauthenticated in Caddy so Fly can reach it without credentials
  - Returns 503 until the full stack (opencode + sidecar + caddy) is ready
  - `bin/run` also waits for opencode before starting Caddy, so the endpoint is unreachable until opencode is live

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
Single Dockerfile, all files under `/opt/mecodes/`. Three processes managed by `run`:
1. **opencode serve** on `:4096` (`--hostname 0.0.0.0`, `OPENCODE_SERVER_PASSWORD` unset)
2. **Sidecar** (Python/FastAPI/uvicorn) on `:4097`
3. **Caddy** on `:8080` (foreground via `exec`; Fly terminates TLS at edge)

opencode and sidecar are backgrounded. `run` waits for opencode's `/global/health` before starting Caddy.

### Caddy routing
- `/admin/health` → sidecar `:4097` (unauthenticated — Fly health check)
- `/admin/*` → sidecar `:4097` (authenticated)
- `/*` → static file if it exists in our frontend dir, otherwise → opencode `:4096`

This lets `/` serve our `index.html`, while `/session/*`, `/event`, etc. pass through to
the opencode API. The built-in opencode web UI also works: point `app.opencode.ai` at this
server and its API calls reach opencode directly.

### Startup timeline (~23s)
1. Fly starts VM, mounts volume, runs `/opt/mecodes/run`
2. `run` hashes `CADDY_AUTH_PASSWORD` via `caddy hash-password` (~1-2s)
3. opencode + sidecar start in background (sidecar is ready almost instantly)
4. opencode does SQLite migration on first boot, then ready on `:4096` (~20s)
5. `run` health-check loop detects opencode, starts Caddy on `:8080` (~22s)
6. Fly health check polls `/admin/health` → deploy completes once the whole stack is up

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

## Local dev
```bash
uv venv && uv pip install -r requirements.txt
```

## Deploys

### One-time setup
```bash
fly apps create dancodes --org jdanbrown
fly volumes create dancodes_vol --app dancodes --region iad --size 10
fly secrets set --app dancodes CADDY_AUTH_USER=... CADDY_AUTH_PASSWORD=... GITHUB_TOKEN=... OPENROUTER_API_KEY=...
```

### Deploys are automatic
- Deploys happen automatically via GitHub Actions on push to `main`.

### Rollbacks
To rollback (e.g. from phone): GitHub → Actions → "Deploy to Fly.io" → Run workflow
- Set `rollback` to `1` (previous commit), `2`, etc.
- Or paste a specific commit SHA into `ref`
- No rolling/blue-green deploys (single machine + volume), so broken deploys require manual rollback

### To deploy manually
```bash
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
- The npm package uses a `#!/usr/bin/env node` shebang, so `node` must exist on PATH
  - We symlink bun as node in the Dockerfile
