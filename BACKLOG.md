# Backlog (see AGENTS.md)
- [2026-02-28] Rename mecodes -> dancodes
- [2026-02-28] Replace '--' -> '—' in *.md
- [2026-02-27] Create dev/check
  - Frontend (ts): `tsc --noEmit` + `biome check` + `vite build`
  - Backend (python): `pyright` + `ruff check` + `ruff format --check`
- [2026-02-26] Add repos/worktrees
  - Not provided by opencode, need to DIY in sidecar + integrate into frontend
- [2026-02-26] Close the dev loop
  - Edit and deploy dancodes from dancodes
