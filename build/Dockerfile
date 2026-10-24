# syntax=docker/dockerfile:1
#
# Builds Custom Relay — so you don't need Node installed anywhere except in this
# container. `npm run build` runs the default flavor (build.d/custom.json), which
# writes dist/{main.js,manifest.json,styles.css}; they are copied to /out, which
# docker-compose maps to ../dist on the host.

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
# esbuild.config.mjs runs `git describe` for build metadata; allow it on this tree.
RUN git config --global --add safe.directory /app || true
RUN npm run build
# Artifacts are now in /app/dist: main.js, manifest.json, styles.css.

CMD ["sh", "-c", "mkdir -p /out && cp -f dist/main.js dist/manifest.json dist/styles.css dist/.gitignore /out/ && echo '--- built artifacts ---' && ls -l /out"]
