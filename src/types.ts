/**
 * Shared types between the executor server (`./server`) and the driver.
 * Type-only — nothing here exists at runtime.
 */

/**
 * Tool schema passed to the executor. Schema only — never the implementation.
 */
export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Request to execute code on the executor.
 */
export interface ExecuteRequest {
  /** Plain JS (TypeScript already stripped by code-mode). */
  code: string
  /** Schemas for every tool the code may call. */
  tools: Array<ToolSchema>
  /** Cached results from prior rounds, keyed by `ToolCallRequest.id`. */
  toolResults?: Record<string, ToolResultPayload> | undefined
  /** Execution timeout in ms. */
  timeout?: number
  /** Memory limit in MB. */
  memoryLimit?: number
}

/**
 * A tool call the executor wants the driver to run on the host.
 */
export interface ToolCallRequest {
  /** Stable, sequential id (`tc_0`, `tc_1`, ...) — re-derived each round. */
  id: string
  /** Name of the tool to call. */
  name: string
  /** Arguments to pass to the tool. */
  args: unknown
}

/**
 * Result of a host-side tool call, sent back to the executor.
 */
export interface ToolResultPayload {
  /** Whether the tool call succeeded. */
  success: boolean
  /** The result value if successful. */
  value?: unknown
  /** Error message if failed. */
  error?: string
}

/**
 * Response from the executor — either done, needs tool calls, or errored.
 */
export type ExecuteResponse =
  | {
      status: 'done'
      success: boolean
      value?: unknown
      error?:
        | {
            name: string
            message: string
            stack?: string | undefined
          }
        | undefined
      logs: Array<string>
    }
  | {
      status: 'need_tools'
      toolCalls: Array<ToolCallRequest>
      logs: Array<string>
    }
  | {
      status: 'error'
      error: {
        name: string
        message: string
      }
    }
