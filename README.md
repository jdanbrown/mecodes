# ocweb
Personal service to run opencode on the web like claude code, with custom frontend/mobile
- See AGENTS.md for agent instructions
- See DESIGN.md for system design

## Deploy

Hosted on Fly.io, org `jdanbrown`, app `ocweb`.

```bash
cd backend

# First time: create app + volume (already done)
fly apps create ocweb --org jdanbrown
fly volumes create ocweb_vol --region sjc --size 10 --app ocweb

# Set secrets
fly secrets set \
  CADDY_AUTH_USER=... \
  CADDY_AUTH_HASH='...' \
  GITHUB_TOKEN=... \
  OPENROUTER_API_KEY=... \
  --app ocweb

# Deploy
fly deploy
```
