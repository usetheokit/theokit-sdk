---
"@theokit/sdk": minor
---

A permission gate can defer a tool call. `canUseTool` may return `{ behavior: "defer", reason? }` and a `pre_tool_call` handler may return `{ defer: true, reason? }`: the call is not dispatched, the other calls of the step finish, and the run ends with `status: "deferred"` and `deferredToolCalls`. `pre_tool_call` contexts now carry `toolUseId`. Adds `DeferredToolCall`, `ToolCallDecision` and `ToolDecisionMismatchError` (code `tool_decision_mismatch`). `agent.send(undefined, { toolDecisions })` answers the deferred calls on the same agent or after `Agent.resume(agentId)` in a new process: the calls are read from the transcript (schema-versioned), and an `allow` runs only after the permission floor and deny rules pass again on the stored input. A mismatch throws `ToolDecisionMismatchError`; an unknown record version throws `ConfigurationError` code `deferred_schema_unsupported`.
