---
"@theokit/sdk": patch
---

`agent.memory.delete` now forgets the fact in the Lance index under the agent's own memory root (other agents' indexes are untouched): `LanceIndex.removeFacts([id], { namespace, source: "memory" })`, serialized after any in-flight add on the same storage path, so a sync cannot restore the fact afterwards. Only rows of that namespace and source linked by `fact_id` are removed; legacy rows without `fact_id` match only by exact id. `removeFacts(ids)` without a scope is unchanged (#1206). Limits: only a Lance index open in this process is cleaned (a closed one keeps its rows), and the SDK's own writers do not yet store `fact_id` = MemoryId, so only rows a consumer added with that link are removed.
