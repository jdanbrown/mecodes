# ocweb
Personal service to run opencode on the web like claude code, with custom frontend/mobile
- See [AGENTS.md](AGENTS.md) for agent instructions
- See [DESIGN.md](DESIGN.md) for system design

## Deploy (fly.io)

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
