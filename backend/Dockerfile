FROM debian:bookworm-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git unzip python3 python3-pip python3-venv \
    procps jq \
  && rm -rf /var/lib/apt/lists/*

# Caddy
RUN curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
  && chmod +x /usr/local/bin/caddy

# Bun (for opencode)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# OpenCode
RUN bun install -g opencode-ai@latest

# Sidecar (Python + FastAPI)
COPY sidecar/ /opt/sidecar/
RUN python3 -m venv /opt/sidecar/.venv \
  && /opt/sidecar/.venv/bin/pip install --no-cache-dir -r /opt/sidecar/requirements.txt

# Config files
COPY Caddyfile /etc/caddy/Caddyfile
COPY config.yaml /etc/ocweb/config.yaml
COPY run /run
RUN chmod a+x /run

# Volume mount point
RUN mkdir -p /vol/projects /vol/opencode-state

# Ports: Caddy HTTPS (443) and HTTP (80, for redirect)
EXPOSE 443 80

ENTRYPOINT ["/run"]
