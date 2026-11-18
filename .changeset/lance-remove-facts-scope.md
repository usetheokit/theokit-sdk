---
"@theokit/sdk": patch
---

`agent.memory.delete` can now forget a fact's chunks in the Lance index (`LanceMemoryAdapter.forgetFact` → `LanceIndex.removeFactChunks`, scoped by namespace), and `LanceIndex.beginSync()` plus `addFacts(facts, { since })` stop a sync that read a fact before its removal from restoring it. Writes and removals on one storage path share a queue within the process. `removeFacts(ids)` and `addFacts(facts)` are unchanged (#1206).
