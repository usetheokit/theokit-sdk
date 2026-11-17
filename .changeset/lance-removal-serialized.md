---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`LanceIndex.removeFacts` now removes the rows linked to a fact and nothing else, and runs after any `addFacts` already in flight, so a concurrent sync can no longer restore a removed fact. Chunks are linked through a new `fact_id` column (default: the row's own `id`); tables written earlier get it added on open. The new optional second argument `{ namespace, source }` limits removal to one namespace and source; without it, behaviour across namespaces is unchanged.
