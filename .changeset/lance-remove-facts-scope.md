---
"@theokit/sdk": patch
---

`agent.memory.delete` now forgets the fact in every open Lance index: `LanceIndex.removeFacts([id], { namespace, source: "memory" })`, serialized after any in-flight add on the same storage path, so a sync cannot restore the fact afterwards. Only rows of that namespace and source linked by `fact_id` are removed; legacy rows without `fact_id` match only by exact id. `removeFacts(ids)` without a scope is unchanged (#1206).
