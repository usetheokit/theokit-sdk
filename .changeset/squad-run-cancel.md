---
"@theokit/sdk": minor
---

`Squad.run` accepts `{ signal, timeoutMs }` and cancels the member run in flight (resolving `cancelled`, with `timedOut` on timeout). `agentStep` now cancels its run when the workflow signal aborts, and cancellation propagates through branch, parallel, foreach and dowhile. New `ownsMembers` and `onDisposeError` squad options; members built from an `AgentDefinition` are always disposed.
