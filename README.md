# @iinitz/ai-isolate-remote

A lightweight HTTP server that acts as a **remote execution backend for [TanStack AI Code Mode](https://tanstack.com/ai/latest/docs/code-mode/code-mode)**. It receives LLM-generated JavaScript, runs it in a fresh V8 isolate (`isolated-vm`), and bridges tool calls back to your app — without ever holding your secrets, database access, or tool implementations.

```
 your app (TanStack AI)                    this server (locked down)
┌───────────────────────────┐  POST /execute  ┌──────────────────────────┐
│ chat() + Code Mode        │ ──────────────▶ │ isolated-vm sandbox      │
│ createRemoteIsolateDriver │ ◀────────────── │ runs the generated JS    │
│ real tool impls           │  need_tools /   │ (no tools, no secrets,   │
│ (DB, secrets, network)    │  tool results   │  no network)             │
└───────────────────────────┘                 └──────────────────────────┘
```

The tool implementations stay in **your** process. The untrusted code runs **here**. When the sandboxed code calls a tool, the server returns `need_tools`; the driver runs the tool on your side and re-sends the result. The server needs no secrets and no outbound network — lock it down accordingly.

## Run with Docker

```bash
docker run -p 8080:8080 -e EXECUTOR_TOKEN=change-me iinitz/ai-isolate-remote

curl localhost:8080/health
# {"ok":true}
```

Pin a version for production:

```bash
docker run -p 8080:8080 -e EXECUTOR_TOKEN=change-me iinitz/ai-isolate-remote:1.0.0
```

Images are published for `linux/amd64` and `linux/arm64`. Available tags match npm releases (`1.0.0`, `1.0`, `1`, `latest`).

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EXECUTOR_TOKEN` | _(none)_ | Bearer token required on every `POST /execute`. Set this in production. |
| `PORT` | `8080` | Port the server listens on. |

## Install the client driver

```bash
npm install @iinitz/ai-isolate-remote
```

Use `createRemoteIsolateDriver` in your TanStack AI app to point Code Mode at the running server:

```ts
import { createCodeMode } from '@tanstack/ai-code-mode'
import { createRemoteIsolateDriver } from '@iinitz/ai-isolate-remote'

const { tool, systemPrompt } = createCodeMode({
  driver: createRemoteIsolateDriver({
    endpoint: process.env.EXECUTOR_URL!,              // http(s)://host/execute
    authorization: `Bearer ${process.env.EXECUTOR_TOKEN}`,
  }),
  tools: [myTool],   // implementations stay in your app
})

// pass tool and systemPrompt to chat() as usual
```

### Driver options

```ts
createRemoteIsolateDriver({
  endpoint: string           // required — URL of the /execute endpoint
  authorization?: string     // optional — passed as Authorization header
  timeout?: number           // default 30000 ms per execution round
  memoryLimit?: number       // default 128 MB per isolate
  maxToolRounds?: number     // default 10 — max host→server round-trips
  fetchImpl?: typeof fetch   // optional — inject custom fetch (tests, proxies)
})
```

### Wire types

The protocol types are re-exported from the package entry (e.g. to build a custom driver):

```ts
import type { ExecuteRequest, ExecuteResponse } from '@iinitz/ai-isolate-remote'
```

### Embedding the server

The `./server` subpath exports the executor so you can mount it in your own
Node server or test it without binding a port:

```ts
import { startServer, createRequestListener, runInIsolate } from '@iinitz/ai-isolate-remote/server'

// start a standalone server
await startServer({ port: 8080, token: process.env.EXECUTOR_TOKEN })

// or mount the handler on an existing node:http server
import { createServer } from 'node:http'
createServer(createRequestListener(process.env.EXECUTOR_TOKEN)).listen(8080)
```

> `isolated-vm` is an **optional dependency** — it only installs (and is only
> needed) when you run the server. Driver-only consumers can skip the native
> build. To run the server from source you need a C++ toolchain (`python3 make g++`).

## Build the server locally

```bash
npm install
cp .env.example .env        # set EXECUTOR_TOKEN (optional for local dev)

npm run dev                 # TypeScript directly via tsx
# or
npm run build && npm start  # compile to dist/ then run
```

Build your own Docker image:

```bash
docker build -t ai-isolate-remote .
docker run -p 8080:8080 -e EXECUTOR_TOKEN=change-me ai-isolate-remote
```

## How tool calls work

The executor never holds your tool implementations. Each tool call is recorded with a **sequential id** (`tc_0`, `tc_1`, …). The program is re-run from the top each round, with already-resolved calls returning cached values.

- The id is **positional**, not a hash of the args — this keeps re-execution stable when tool inputs are non-deterministic.
- `Promise.all([a(), b()])` resolves in **one** extra round (both calls are collected, dispatched together, results cached, re-run once).
- Each sequential tool call costs one HTTP round-trip and one full re-execution. Prefer parallel calls in generated code and bump `maxToolRounds` for deeply chained call chains.

## Node version & flags

- `isolated-vm` is a native addon and targets even-numbered **LTS** ABIs. The Docker image is pinned to **Node 24 LTS**. Do not switch to a "Current" release — the V8 ABI may break the build.
- The `--no-node-snapshot` flag is **required** on Node 20+. All run scripts and the Docker `CMD` already pass it.
- Building from source requires `python3 make g++` (installed in the Docker builder stage).

To avoid the native build entirely (e.g. on Node 26), replace `runInIsolate()` in `src/server/index.ts` with [`@tanstack/ai-isolate-quickjs`](https://www.npmjs.com/package/@tanstack/ai-isolate-quickjs) (WASM, no native ABI). The wire protocol and client driver are unchanged.

## Security

This server runs untrusted code. `isolated-vm` is a strong in-process V8 boundary but is **not** a substitute for OS-level isolation. Treat the container as the real security perimeter:

- Run it read-only with a non-root user (already set to `USER node` in the image)
- Drop all egress network access
- Use `--security-opt no-new-privileges`
- Keep it on a separate host or process from anything sensitive
- Always set `EXECUTOR_TOKEN` in production

## Files

This package mirrors the layout of the official TanStack isolate drivers (e.g.
[`@tanstack/ai-isolate-cloudflare`](https://www.npmjs.com/package/@tanstack/ai-isolate-cloudflare)):

```
src/index.ts            public entry — re-exports the driver + wire types  (".")
src/isolate-driver.ts   the createRemoteIsolateDriver() client driver
src/types.ts            request/response wire types shared by both sides
src/server/index.ts     executor: runInIsolate + HTTP handler + startServer  ("./server")
src/server/wrap-code.ts sandbox code wrapping + tool-name validation
src/server/start.ts     runnable entry (Docker CMD / npm start)
Dockerfile              Node 24 LTS, multi-stage, linux/amd64 + linux/arm64
```
