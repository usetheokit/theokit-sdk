---
"@theokit/sdk": minor
---

Add `AgentOptions.sendDefaults` (`toolResultGuard`, `pruneToolResults`, `perToolTimeoutMs`), applied to every local send of the agent, merged per key under the call's options, validated at create and resume, and persisted for resume (#1020).
