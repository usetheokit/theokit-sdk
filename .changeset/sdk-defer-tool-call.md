---
"@theokit/sdk": minor
---

A permission gate can defer a tool call. `canUseTool` may return `{ behavior: "defer", reason? }` and a `pre_tool_call` handler may return `{ defer: true, reason? }`: the call is not dispatched, the other calls of the step finish, and the run ends with `status: "deferred"` and `deferredToolCalls`. `pre_tool_call` contexts now carry `toolUseId`. Adds the `DeferredToolCall` and `ToolCallDecision` types. Answering deferred calls is a follow-up.
