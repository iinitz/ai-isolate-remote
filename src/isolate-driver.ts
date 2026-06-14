import type {
  ExecutionResult,
  IsolateConfig,
  IsolateContext,
  IsolateDriver,
  ToolBinding,
} from '@tanstack/ai-code-mode'
import type {
  ExecuteRequest,
  ExecuteResponse,
  ToolResultPayload,
  ToolSchema,
} from './types.js'

/**
 * Configuration for the remote isolate driver.
 */
export interface RemoteIsolateDriverConfig {
  /**
   * URL of the executor server's `/execute` endpoint.
   * For local development, use: http://localhost:8080/execute
   */
  endpoint: string

  /**
   * Optional authorization header value.
   * Useful for protecting your executor endpoint.
   */
  authorization?: string

  /**
   * Default execution timeout in ms (default: 30000)
   */
  timeout?: number

  /**
   * Default memory limit in MB (default: 128)
   */
  memoryLimit?: number

  /**
   * Maximum number of tool callback rounds (default: 10)
   * Prevents infinite loops.
   */
  maxToolRounds?: number

  /**
   * Inject a custom fetch (tests, proxies, retries). Defaults to global fetch.
   */
  fetchImpl?: typeof fetch
}

/**
 * Convert tool bindings to schemas for the executor.
 */
function bindingsToSchemas(
  bindings: Record<string, ToolBinding>,
): Array<ToolSchema> {
  return Object.entries(bindings).map(([name, binding]) => ({
    name,
    description: binding.description,
    inputSchema: binding.inputSchema,
  }))
}

/**
 * Normalize errors from various sources.
 */
function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>
    return {
      name: String(e.name || 'Error'),
      message: String(e.message || JSON.stringify(error)),
    }
  }
  return { name: 'Error', message: String(error) }
}

/**
 * IsolateContext implementation backed by a remote executor server.
 */
class RemoteIsolateContext implements IsolateContext {
  private readonly endpoint: string
  private readonly authorization?: string
  private readonly timeout: number
  private readonly memoryLimit: number
  private readonly maxToolRounds: number
  private readonly fetchImpl: typeof fetch
  private readonly bindings: Record<string, ToolBinding>
  private disposed = false

  constructor(
    endpoint: string,
    bindings: Record<string, ToolBinding>,
    timeout: number,
    memoryLimit: number,
    maxToolRounds: number,
    fetchImpl: typeof fetch,
    authorization?: string,
  ) {
    this.endpoint = endpoint
    this.bindings = bindings
    this.timeout = timeout
    this.memoryLimit = memoryLimit
    this.maxToolRounds = maxToolRounds
    this.fetchImpl = fetchImpl
    this.authorization = authorization
  }

  async execute<T = unknown>(code: string): Promise<ExecutionResult<T>> {
    if (this.disposed) {
      return {
        success: false,
        error: {
          name: 'DisposedError',
          message: 'Context has been disposed',
        },
        logs: [],
      }
    }

    const tools = bindingsToSchemas(this.bindings)
    let toolResults: Record<string, ToolResultPayload> | undefined
    let allLogs: Array<string> = []
    let rounds = 0

    // Request/response loop for tool callbacks
    while (rounds < this.maxToolRounds) {
      rounds++

      const request: ExecuteRequest = {
        code,
        tools,
        toolResults,
        timeout: this.timeout,
        memoryLimit: this.memoryLimit,
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }

        if (this.authorization) {
          headers['Authorization'] = this.authorization
        }

        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          return {
            success: false,
            error: {
              name: 'ExecutorError',
              message: `Executor returned ${response.status}: ${errorText}`,
            },
            logs: allLogs,
          }
        }

        const result = (await response.json()) as ExecuteResponse

        if (result.status === 'error') {
          return {
            success: false,
            error: result.error,
            logs: allLogs,
          }
        }

        if (result.status === 'done') {
          allLogs = [...allLogs, ...result.logs]
          const resultError = result.error
          return {
            success: result.success,
            value: result.value as T,
            ...(resultError !== undefined
              ? {
                  error: {
                    name: resultError.name,
                    message: resultError.message,
                    ...(resultError.stack !== undefined
                      ? { stack: resultError.stack }
                      : {}),
                  },
                }
              : {}),
            logs: allLogs,
          }
        }

        // status === 'need_tools'
        // Collect logs from this round
        allLogs = [...allLogs, ...result.logs]

        // Execute tool calls locally. Accumulate across rounds so prior-round
        // results stay cached when the executor re-executes user code.
        // wrap-code uses sequential `tc_<idx>` ids re-derived every round; if
        // we wipe the cache, multi-tool programs ping-pong between missing
        // ids and exhaust `maxToolRounds` (MaxRoundsExceeded).
        toolResults = { ...(toolResults ?? {}) }

        for (const toolCall of result.toolCalls) {
          const binding = this.bindings[toolCall.name]

          if (!binding) {
            toolResults[toolCall.id] = {
              success: false,
              error: `Unknown tool: ${toolCall.name}`,
            }
            continue
          }

          try {
            const toolResult = await binding.execute(toolCall.args)
            toolResults[toolCall.id] = {
              success: true,
              value: toolResult,
            }
          } catch (toolError) {
            const err = normalizeError(toolError)
            toolResults[toolCall.id] = {
              success: false,
              error: err.message,
            }
          }
        }

        // Continue loop to send results back to the executor
      } catch (fetchError) {
        const err = normalizeError(fetchError)
        return {
          success: false,
          error: {
            name: 'NetworkError',
            message: `Failed to reach executor: ${err.message}`,
          },
          logs: allLogs,
        }
      }
    }

    // Max rounds exceeded
    return {
      success: false,
      error: {
        name: 'MaxRoundsExceeded',
        message: `Exceeded maximum tool callback rounds (${this.maxToolRounds})`,
      },
      logs: allLogs,
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

/**
 * Create a remote isolate driver.
 *
 * This driver delegates code execution to a remote executor server (the
 * `@iinitz/ai-isolate-remote` Docker image), which runs the generated code in
 * an `isolated-vm` sandbox. Tool implementations never leave your process.
 *
 * Tool calls are handled via a request/response loop:
 * 1. Code is sent to the executor
 * 2. Executor runs until it needs a tool
 * 3. Tool call is returned to the driver
 * 4. Driver executes the tool locally
 * 5. Result is sent back to the executor
 * 6. Executor continues execution
 *
 * @example
 * ```typescript
 * import { createRemoteIsolateDriver } from '@iinitz/ai-isolate-remote'
 *
 * // For local development
 * const driver = createRemoteIsolateDriver({
 *   endpoint: 'http://localhost:8080/execute',
 * })
 *
 * // For production
 * const driver = createRemoteIsolateDriver({
 *   endpoint: 'https://executor.example.com/execute',
 *   authorization: `Bearer ${process.env.EXECUTOR_TOKEN}`,
 * })
 * ```
 */
export function createRemoteIsolateDriver(
  config: RemoteIsolateDriverConfig,
): IsolateDriver {
  const {
    endpoint,
    authorization,
    timeout: defaultTimeout = 30_000,
    memoryLimit: defaultMemoryLimit = 128,
    maxToolRounds = 10,
    fetchImpl = fetch,
  } = config

  return {
    createContext(isolateConfig: IsolateConfig): Promise<IsolateContext> {
      const timeout = isolateConfig.timeout ?? defaultTimeout
      const memoryLimit = isolateConfig.memoryLimit ?? defaultMemoryLimit

      return Promise.resolve(
        new RemoteIsolateContext(
          endpoint,
          isolateConfig.bindings,
          timeout,
          memoryLimit,
          maxToolRounds,
          fetchImpl,
          authorization,
        ),
      )
    },
  }
}
