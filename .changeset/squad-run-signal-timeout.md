---
"@theokit/sdk": minor
---

`Squad.run` takes `{ signal, timeoutMs }` and cancels the member run in flight (`timedOut: true` on timeout). New `ownsMembers` and `onDisposeError` options; members built from an `AgentDefinition` are always disposed. `agentStep` now cancels its in-flight run when the workflow signal aborts, and `StepResult.status` may be `"cancelled"`.
