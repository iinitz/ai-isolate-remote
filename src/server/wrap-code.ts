/**
 * Code wrapping for the executor sandbox.
 *
 * Tool calls are keyed by a SEQUENTIAL index, re-derived every round, so cached
 * results line up across re-executions even when tool inputs are
 * non-deterministic. Do not switch this to hashing the args.
 */
import type { ToolResultPayload, ToolSchema } from '../types.js'

const VALID_TOOL_NAME = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public',
  'await', 'async',
])

export function assertSafeToolName(name: string): void {
  if (!VALID_TOOL_NAME.test(name)) {
    throw new Error(`Invalid tool name '${name}': must match ${VALID_TOOL_NAME}`)
  }
  if (RESERVED.has(name)) {
    throw new Error(`Invalid tool name '${name}': reserved JavaScript keyword`)
  }
}

function generateToolWrappers(
  tools: Array<ToolSchema>,
  toolResults?: Record<string, ToolResultPayload>,
): string {
  return tools
    .map((tool) => {
      assertSafeToolName(tool.name)
      const cacheBranch = toolResults
        ? `const r = __toolResults[callId];
           if (!r) { __pending.push({ id: callId, name: '${tool.name}', args: input }); throw new __ToolCallNeeded(callId); }
           if (!r.success) throw new Error(r.error || 'Tool call failed');
           return r.value;`
        : `__pending.push({ id: callId, name: '${tool.name}', args: input });
           throw new __ToolCallNeeded(callId);`
      return `async function ${tool.name}(input) {
        const callId = 'tc_' + (__idx++);
        ${cacheBranch}
      }`
    })
    .join('\n')
}

/**
 * Wrap user code in an async IIFE that returns a structured result object.
 * Tool calls throw a sentinel that surfaces a `need_tools` response.
 */
export function wrapCode(
  code: string,
  tools: Array<ToolSchema>,
  toolResults?: Record<string, ToolResultPayload>,
): string {
  const wrappers = generateToolWrappers(tools, toolResults)
  const resultsJson = toolResults ? JSON.stringify(toolResults) : '{}'
  return `
    (async function () {
      let __idx = 0;
      const __pending = [];
      const __toolResults = ${resultsJson};
      const __logs = [];
      class __ToolCallNeeded extends Error {
        constructor(id) { super('tool needed: ' + id); this.callId = id; }
      }
      function __fmt(x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }
      const console = {
        log:  (...a) => __logs.push(a.map(__fmt).join(' ')),
        error:(...a) => __logs.push('ERROR: ' + a.map(__fmt).join(' ')),
        warn: (...a) => __logs.push('WARN: '  + a.map(__fmt).join(' ')),
        info: (...a) => __logs.push('INFO: '  + a.map(__fmt).join(' ')),
      };
      ${wrappers}
      try {
        const __value = await (async function () { ${code} })();
        return { status: 'done', success: true, value: __value, logs: __logs };
      } catch (__e) {
        if (__e instanceof __ToolCallNeeded) {
          return { status: 'need_tools', toolCalls: __pending, logs: __logs };
        }
        return {
          status: 'done', success: false, logs: __logs,
          error: { name: __e.name || 'Error', message: __e.message || String(__e), stack: __e.stack },
        };
      }
    })()
  `
}
