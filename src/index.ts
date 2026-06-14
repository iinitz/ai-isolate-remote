/**
 * @iinitz/ai-isolate-remote
 *
 * Remote isolate driver for TanStack AI Code Mode. Execute LLM-generated code
 * on a remote executor server that runs it in an `isolated-vm` sandbox, while
 * tool implementations stay in your own process.
 *
 * @example
 * ```typescript
 * import { createRemoteIsolateDriver } from '@iinitz/ai-isolate-remote'
 *
 * const driver = createRemoteIsolateDriver({
 *   endpoint: 'http://localhost:8080/execute',
 * })
 * ```
 *
 * @packageDocumentation
 */

export {
  createRemoteIsolateDriver,
  type RemoteIsolateDriverConfig,
} from './isolate-driver.js'

export type {
  ExecuteRequest,
  ExecuteResponse,
  ToolSchema,
  ToolCallRequest,
  ToolResultPayload,
} from './types.js'
