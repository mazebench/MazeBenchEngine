# Container image for running MazeBench with a local coding agent (Codex CLI or
# Claude Code) in full isolation from the host filesystem. The agent, Node, the
# maze runtime, a headless Chromium (for vision + replay video) and ffmpeg all
# live inside the image; only an output directory is mounted at run time.
#
# Build:
#   docker build -t mazebench-agent .
# (or: npm run maze:build-image)
#
# The Playwright base image already bundles Node.js + Chromium + the system
# libraries the browser needs, matching the playwright-core version this repo
# pins.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# Agent CLI versions — override with --build-arg CODEX_VERSION=... etc.
ARG CODEX_VERSION=0.142.5
ARG CLAUDE_VERSION=2.1.201

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    MAZEBENCH_IN_CONTAINER=1

# ffmpeg is needed for replay video; bubblewrap is Codex's Linux sandbox helper
# (workspace-write). The browser + node come from the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Install the local coding agents globally.
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}"

WORKDIR /app

# Install JS deps first for better layer caching. --include=dev is required so
# playwright-core (a devDependency used by the vision/replay renderer) is present
# despite NODE_ENV=production.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy the maze runtime. .dockerignore keeps host node_modules/.venv/outputs out.
COPY . .

# Run as the non-root user shipped by the Playwright image, and make the app +
# the mounted output tree writable by it. The .codex/.claude dirs are created so
# a mounted auth file lands in a writable dir (the agents write session/cache
# files there at run time).
RUN mkdir -p /app/outputs/maze-local /home/pwuser/.codex /home/pwuser/.claude \
    && chown -R pwuser:pwuser /app /home/pwuser/.codex /home/pwuser/.claude
USER pwuser

# Credentials are provided at run time via env (OPENAI_API_KEY / ANTHROPIC_API_KEY)
# or by mounting the agent's auth dir. The runner command is supplied by
# scripts/maze-agent-local.js; default to its help.
ENTRYPOINT []
CMD ["node", "scripts/maze-agent-local.js"]
