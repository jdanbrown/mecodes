FROM debian:bookworm-slim

WORKDIR /opt/mecodes

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    unzip \
    python3 \
    python3-pip \
    python3-venv \
    procps \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Install caddy
RUN curl -fsSL 'https://caddyserver.com/api/download?os=linux&arch=amd64' -o /usr/local/bin/caddy \
  && chmod a+x /usr/local/bin/caddy

# Install bun
RUN curl -fsSL 'https://bun.sh/install' | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install opencode
# - "Install" node as bun, for the opencode shebang
RUN bun install -g opencode-ai@latest \
  && ln -s /root/.bun/bin/bun /usr/local/bin/node

# Setup python env
# - Restrict COPY to just requirements.txt, because `COPY . .` busts cache on _any_ file change -- annoying in dev
# - Precompile .pyc at build time so the slow shared CPU doesn't have to at startup
COPY requirements.txt .
RUN python3 -m venv sidecar/.venv \
  && sidecar/.venv/bin/pip install --no-cache-dir -r requirements.txt \
  && python3 -m compileall -q sidecar/.venv

# Copy project dir
COPY . .
RUN chmod a+x bin/*

# Volume mount point
RUN mkdir -p /vol/projects /vol/opencode-state

EXPOSE 8080

ENTRYPOINT ["/opt/mecodes/bin/run"]
