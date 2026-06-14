/**
 * Remote executor server for TanStack AI Code Mode.
 *
 * Receives LLM-generated JavaScript over HTTP and runs it in a fresh V8 isolate
 * (isolated-vm). Tool implementations never run here — when the code calls a
 * tool, the executor returns `status: "need_tools"` and the driver runs that
 * tool back in your app, then re-sends the cached result. So this server needs
 * no secrets, no DB, and no outbound network. Lock it down accordingly.
 *
 * Importing this module has no side effects. To run the server directly use the
 * `./start` entry (the Docker image and `npm start` do), or call `startServer()`
 * yourself. The `--no-node-snapshot` flag is required on Node 20+.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import ivm from 'isolated-vm'
import { wrapCode } from './wrap-code.js'
import type { ExecuteRequest, ExecuteResponse } from '../types.js'

// ---------------------------------------------------------------------------
// Isolated execution
// ---------------------------------------------------------------------------

/**
 * Run one round of code in a fresh isolate. Returns `done`, `need_tools`, or
 * `error`. The driver drives the multi-round tool loop.
 */
export async function runInIsolate(
  request: ExecuteRequest,
): Promise<ExecuteResponse> {
  const { code, tools, toolResults, timeout = 30_000, memoryLimit = 128 } =
    request

  let wrapped: string
  try {
    wrapped = wrapCode(code, tools, toolResults)
  } catch (e) {
    const err = e as Error
    return { status: 'error', error: { name: err.name, message: err.message } }
  }

  const isolate = new ivm.Isolate({ memoryLimit })
  try {
    const context = await isolate.createContext()
    // The wrapped IIFE returns a Promise<resultObject>; resolve it inside the
    // isolate and hand back a JSON string (a transferable primitive).
    const script = await isolate.compileScript(
      `(${wrapped}).then(function (r) { return JSON.stringify(r); })`,
    )
    const json = (await script.run(context, { promise: true, timeout })) as string
    return JSON.parse(json) as ExecuteResponse
  } catch (e) {
    const err = e as Error
    if (/timed out/i.test(err.message)) {
      return {
        status: 'error',
        error: {
          name: 'TimeoutError',
          message: `Execution timed out after ${timeout}ms`,
        },
      }
    }
    return {
      status: 'error',
      error: { name: err.name || 'EvalError', message: err.message },
    }
  } finally {
    isolate.dispose()
  }
}

// ---------------------------------------------------------------------------
// HTTP surface (node:http — no framework)
// ---------------------------------------------------------------------------

const MAX_BODY = 1_000_000 // 1 MB

/** Options for {@link startServer}. */
export interface ServerOptions {
  /** Port to listen on (default: `process.env.PORT` ?? 8080). */
  port?: number
  /** Bearer token required on `POST /execute` (default: `process.env.EXECUTOR_TOKEN`). */
  token?: string | undefined
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('PayloadTooLarge'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Build the `node:http` request listener. Exported so you can mount it in your
 * own server or test it without binding a port.
 */
export function createRequestListener(
  token?: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true })
    }

    if (req.method !== 'POST' || req.url !== '/execute') {
      return send(res, 404, {
        status: 'error',
        error: { name: 'NotFound', message: 'use POST /execute' },
      })
    }

    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, {
        status: 'error',
        error: { name: 'Unauthorized', message: 'bad token' },
      })
    }

    let body: ExecuteRequest
    try {
      body = JSON.parse(await readBody(req)) as ExecuteRequest
    } catch (e) {
      const tooLarge = (e as Error).message === 'PayloadTooLarge'
      return send(res, tooLarge ? 413 : 400, {
        status: 'error',
        error: {
          name: tooLarge ? 'PayloadTooLarge' : 'BadRequest',
          message: tooLarge ? 'body too large' : 'invalid JSON',
        },
      })
    }

    if (!body || typeof body.code !== 'string') {
      return send(res, 400, {
        status: 'error',
        error: { name: 'BadRequest', message: 'code is required' },
      })
    }

    try {
      send(res, 200, await runInIsolate(body))
    } catch (e) {
      send(res, 500, {
        status: 'error',
        error: { name: 'ServerError', message: (e as Error).message },
      })
    }
  }

  return (req, res) => {
    void handle(req, res)
  }
}

/**
 * Create and start the executor HTTP server. Resolves once it is listening.
 */
export function startServer(options: ServerOptions = {}): Promise<Server> {
  const port = options.port ?? Number(process.env.PORT ?? 8080)
  const token = options.token ?? process.env.EXECUTOR_TOKEN
  const server = createServer(createRequestListener(token))

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`executor listening on :${port}`)
      resolve(server)
    })
  })
}
