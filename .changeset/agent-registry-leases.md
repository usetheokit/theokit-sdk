---
"@theokit/sdk": minor
---

Add `Agent.lease` and `AgentLease`: a hold on a live agent so the registry's LRU, idle sweep and `evict` never dispose it while a turn is running (#1016).
