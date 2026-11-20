---
"@theokit/sdk": minor
---

A permission gate can defer a tool call. `canUseTool` may return `{ behavior: "defer", reason? }` and a `pre_tool_call` handler may return `{ defer: true, reason? }`: the call is not dispatched, the other calls of the step finish, and the run ends with `status: "deferred"` and `deferredToolCalls`. `pre_tool_call` contexts now carry `toolUseId`. Adds `DeferredToolCall`, `ToolDecisionMismatchError` (code `tool_decision_mismatch`, thrown by a send on a session that ends on deferred calls). An unknown stored record version throws `ConfigurationError` code `deferred_schema_unsupported`. Answering deferred calls is a follow-up.
