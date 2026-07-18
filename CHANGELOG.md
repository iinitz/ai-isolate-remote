# @iinitz/ai-isolate-remote

## 1.0.2

### Patch Changes

- db4b573: Fix `wrapCode()` so a locally caught (`try`/`catch` or `.catch()`) tool call still triggers a real tool round-trip instead of silently resolving with a fabricated `"tool needed: tc_N"` error string. Detection now checks for unresolved pending tool calls after the wrapped code settles, on both the success and error paths, rather than relying solely on the `__ToolCallNeeded` sentinel propagating uncaught.
