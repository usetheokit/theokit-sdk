---
"@theokit/sdk": minor
---

A permission gate can defer a tool call. `canUseTool` may return `{ behavior: "defer", reason? }` and a `pre_tool_call` handler may return `{ defer: true, reason? }`: the call is not dispatched, the other calls of the step finish, and the run ends with `status: "deferred"` and `deferredToolCalls`. `run.wait()` resolves as deferred only after the transcript holding the unanswered `tool_use` is written, and rejects with `DeferredTranscriptWriteError` if that write fails. `pre_tool_call` contexts now carry `toolUseId`. Adds `DeferredToolCall`, `ToolDecisionMismatchError` (code `tool_decision_mismatch`, thrown by a send on a session that ends on deferred calls) and `DeferredTranscriptWriteError`. An unknown stored record version throws `ConfigurationError` code `deferred_schema_unsupported`. Answering deferred calls is a follow-up.
