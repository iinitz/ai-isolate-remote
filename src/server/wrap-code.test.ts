/**
 * Regression tests for wrapCode()'s tool-call round-trip detection.
 * Framework-free: run with `node --import tsx src/server/wrap-code.test.ts`.
 *
 * Executes wrapCode()'s output directly via `new Function(...)` — it's a
 * plain async IIFE with no isolated-vm-specific syntax, so no native
 * dependency is needed to exercise the control-flow bug this covers.
 */
import assert from 'node:assert/strict'
import { wrapCode } from './wrap-code.js'
import type { ToolResultPayload, ToolSchema } from '../types.js'

const tools: Array<ToolSchema> = [
  { name: 'external_foo', description: 'foo', inputSchema: {} },
  { name: 'external_bar', description: 'bar', inputSchema: {} },
]

async function run(code: string, toolResults?: Record<string, ToolResultPayload>): Promise<any> {
  const wrapped = wrapCode(code, tools, toolResults)
  // Parenthesize: wrapped starts with a newline, and `return\n(...)` hits
  // ASI (return; then an unreachable expression) unless `(` sits right
  // after `return` on the same line.
  return new Function(`return (${wrapped})`)()
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`not ok - ${name}`)
    throw err
  }
}

await test('baseline: uncaught tool call round-trips normally', async () => {
  const round1 = await run('return await external_foo({});')
  assert.equal(round1.status, 'need_tools')
  assert.deepEqual(round1.toolCalls, [{ id: 'tc_0', name: 'external_foo', args: {} }])

  const round2 = await run('return await external_foo({});', { tc_0: { success: true, value: 42 } })
  assert.deepEqual(round2, { status: 'done', success: true, value: 42, logs: [] })
})

await test('bug case: locally caught tool call still triggers need_tools', async () => {
  const result = await run(
    'return await external_foo({}).catch(e => ({ error: String(e) }));',
  )
  assert.equal(result.status, 'need_tools')
  assert.deepEqual(result.toolCalls, [{ id: 'tc_0', name: 'external_foo', args: {} }])
})

await test('multiple locally caught tool calls are all reported in one round', async () => {
  const result = await run(`
    const a = await external_foo({}).catch(e => ({ error: String(e) }));
    const b = await external_bar({}).catch(e => ({ error: String(e) }));
    return [a, b];
  `)
  assert.equal(result.status, 'need_tools')
  assert.deepEqual(result.toolCalls, [
    { id: 'tc_0', name: 'external_foo', args: {} },
    { id: 'tc_1', name: 'external_bar', args: {} },
  ])
})

await test('genuine tool failure still throws a normal catchable Error', async () => {
  const result = await run(
    'return await external_foo({}).catch(e => ({ caught: e.message }));',
    { tc_0: { success: false, error: 'boom' } },
  )
  assert.deepEqual(result, {
    status: 'done',
    success: true,
    value: { caught: 'boom' },
    logs: [],
  })
})

await test('unrelated uncaught error is unaffected', async () => {
  const result = await run('throw new Error("nope");')
  assert.equal(result.status, 'done')
  assert.equal(result.success, false)
  assert.equal(result.error.message, 'nope')
})

console.log('all wrap-code tests passed')
