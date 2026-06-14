# Remote executor image.
#   docker build -t ai-isolate-remote .
#   docker run -p 8080:8080 -e EXECUTOR_TOKEN=change-me ai-isolate-remote
#
# Pinned to Node 26: isolated-vm@7 requires Node >=26. It ships prebuilt
# binaries for linux x64/arm64 (glibc), so no native compile is needed on this
# image — the node-gyp toolchain below is only a fallback if a prebuild for the
# running ABI is ever missing.

# ---- builder: install deps (isolated-vm prebuild) + transpile TS ----
FROM node:26-bookworm-slim AS builder
WORKDIR /app

# node-gyp toolchain — fallback only; isolated-vm@7 normally uses a prebuild
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# drop dev deps (tsx, typescript); keep isolated-vm + @tanstack/ai-code-mode
RUN npm prune --omit=dev

# ---- runtime: slim, no build tools ----
FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080
USER node
# --no-node-snapshot is REQUIRED by isolated-vm on Node 20+
CMD ["node", "--no-node-snapshot", "dist/server/start.js"]
