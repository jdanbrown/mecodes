# Project context
Personal "Claude Code Web" alternative using `opencode serve` + custom frontends
- Use `README.md` to understand and document design, architecture, tradeoffs, decisions, etc.
- Update `README.md` as we go so that we keep it evergreen and always up to date

# Working style
- This is a personal-use project — optimize for simplicity and speed over polish
- Cut corners on scale, resource multiplexing, multi-tenancy — it's one user on one machine
- Surface internal state rather than hiding it — better to see and control than to abstract away
- If a solution seems unreasonably complex, pause and present approaches before diving in

## Tech decisions
- Backend: Caddy (TLS + auth) → single `opencode serve` process + small sidecar
- Sidecar: manages git clone/worktree lifecycle + resource dashboard
- Frontend: web-first (mobile-friendly), iOS-native later
- Hosting: Fly.io, 1 machine + 1 volume
- Auth: Caddy layer only, `OPENCODE_SERVER_PASSWORD` unset

## Coding style
- No trailing whitespace
- Always one trailing newline at end of file
- Always trailing commas (on languages that allow it)
- Comments: very sparingly, focus on "why" not "what"
- Don't add comments about removed code — future readers don't care

## Python style
- No empty `__init__.py` files (that's a py2 thing)
- Order code top-down: public API / endpoints first, models and helpers below
  - Reader should encounter purpose before details, not the other way around
  - Exception: types/models must be defined before they're referenced, so they go above endpoints

## Key APIs to know
- OpenCode REST + SSE API: the frontend talks to this directly for all session/chat operations
- Sidecar API (`/admin/...`): git lifecycle, resource management, orphan detection
- Always use the opencode API to stop sessions, never raw `kill`

## Searching docs and examples
- Code APIs change often — eagerly search with `context7` tool to avoid outdated knowledge
- Use `github_grep` for code examples across repos
- Use `webfetch` pointed at duckduckgo for web searches (don't use google, requires JS)
