---
"@iinitz/ai-isolate-remote": patch
---

Fix `wrapCode()` so a locally caught (`try`/`catch` or `.catch()`) tool call still triggers a real tool round-trip instead of silently resolving with a fabricated `"tool needed: tc_N"` error string. Detection now checks for unresolved pending tool calls after the wrapped code settles, on both the success and error paths, rather than relying solely on the `__ToolCallNeeded` sentinel propagating uncaught.
