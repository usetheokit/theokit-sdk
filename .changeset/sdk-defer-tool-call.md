---
"@theokit/sdk": minor
---

A permission gate can defer a tool call, and `agent.send(message, { toolDecisions })` resumes it, also after a process restart. `canUseTool` may return `{ behavior: "defer", reason? }` and a `pre_tool_call` handler may return `{ defer: true, reason? }`: the call is not dispatched, the other calls of the step finish, and the run ends with `status: "deferred"` and `deferredToolCalls`. `toolDecisions` takes one `allow` or `deny` per pending `toolUseId`, read from the stored transcript: an `allow` runs the stored call after the permission rules, floors and hooks run again (an approval never overrides a deny), a `deny` writes an error result. Unknown or repeated ids, missing decisions and unsupported `schemaVersion`s reject with `ConfigurationError` and leave the session unchanged. `pre_tool_call` contexts now carry `toolUseId`. Adds the `DeferredToolCall` and `ToolCallDecision` types.
