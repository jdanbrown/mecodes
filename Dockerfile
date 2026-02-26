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

# OpenCode (the npm package shebang uses `node`, so symlink bun as node)
RUN bun install -g opencode-ai@latest \
  && ln -s /root/.bun/bin/bun /usr/local/bin/node

# All our files live under /opt/mecodes
WORKDIR /opt/mecodes
COPY . .
RUN chmod a+x run
RUN python3 -m venv sidecar/.venv \
  && sidecar/.venv/bin/pip install --no-cache-dir -r requirements.txt

# Volume mount point
RUN mkdir -p /vol/projects /vol/opencode-state

EXPOSE 8080

ENTRYPOINT ["/opt/mecodes/run"]
