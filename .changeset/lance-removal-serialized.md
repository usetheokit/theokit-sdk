---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`LanceIndex.removeFacts` now runs after any `addFacts` already in flight on the same storage path, so a concurrent sync can no longer restore a removed fact. Chunks of a split fact are linked through a new `fact_id` column (default: the row's own `id`). An older table gets the column on open; its existing rows keep `fact_id` NULL, no parent link is guessed for them, and they are removed by exact id only. The new optional second argument `{ namespace, source }` removes every row linked to the fact, limited to that namespace and source; without it, removal is the exact-id deletion it was.

There is still no fact-forget call site in the SDK that uses this; wiring one in is separate work.
