# syntax=docker/dockerfile:1
#
# Builds the Relay plugin fork into main.js — so you don't need Node installed
# anywhere except in this container. Output (main.js, manifest.json, styles.css)
# is copied to /out, which docker-compose maps to ../dist on the host.

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install deps first (cached unless package files change).
COPY package.json package-lock.json ./
RUN npm ci

# Then the source, and build.
COPY . .
# esbuild.config.mjs runs `git describe` for the version; allow it on this tree.
RUN git config --global --add safe.directory /app || true
RUN npm run build
# Artifacts are now in /app: main.js, manifest.json, styles.css.

CMD ["sh", "-c", "mkdir -p /out && cp -f main.js manifest.json styles.css /out/ && echo '--- built artifacts ---' && ls -l /out"]
