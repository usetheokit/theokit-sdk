---
"@theokit/sdk": patch
---

`agent.memory.delete` now forgets the fact's chunks in every open Lance index (`LanceIndex.removeFactChunks`, scoped by namespace and source, both required). Facts of `agent.memory` are written by `LanceIndex.indexFact` / `syncFacts` under the id `<escaped factId>#<chunk>`, so a fact id that is a prefix of another's never matches it; `syncFacts` calls `beginSync()` before reading and passes `{ since }`, so a sync that read a fact before its removal cannot restore it. `removeFacts(ids)` and `addFacts(facts)` are unchanged; legacy migrated rows with no fact link are never removed by a forget (#1206).
