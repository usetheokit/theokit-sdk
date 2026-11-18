---
"@theokit/sdk": minor
---

`Squad.run(input, { signal, timeoutMs })` cancels the member run in flight and resolves with `status: "cancelled"` (`timedOut: true` on timeout). `agentStep` now cancels its in-flight agent run when the workflow signal aborts, and reports a `cancelled` step result. Members built from an `AgentDefinition` are disposed after each run; `ownsMembers: true` disposes passed-in members too, and disposal failures go to `onDisposeError` without failing the run.
