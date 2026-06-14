# Remote executor image.
#   docker build -t ai-isolate-remote .
#   docker run -p 8080:8080 -e EXECUTOR_TOKEN=change-me ai-isolate-remote
#
# Pinned to Node 24 LTS on purpose: isolated-vm is a native addon that targets
# even-numbered LTS ABIs and does not track bleeding-edge V8, so newer
# "Current" Node lines may fail to build.

# ---- builder: compile isolated-vm (native) + transpile TS ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# node-gyp toolchain for isolated-vm
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
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080
USER node
# --no-node-snapshot is REQUIRED by isolated-vm on Node 20+
CMD ["node", "--no-node-snapshot", "dist/server/start.js"]
