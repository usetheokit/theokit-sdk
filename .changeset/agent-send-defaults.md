---
"@theokit/sdk": minor
---

Add `AgentOptions.sendDefaults` (`toolResultGuard`, `pruneToolResults`, `perToolTimeoutMs`) applied to every local send, merged per key under the call's options; an invalid `pruneToolResults` default fails at `Agent.create`/`Agent.resume` (#1020).
