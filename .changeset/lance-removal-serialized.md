---
"@theokit/sdk": minor
"@theokit/sdk-memory": minor
---

`LanceIndex.removeFacts` now removes the rows linked to a fact and nothing else, and runs after any `addFacts` already in flight, so a concurrent sync can no longer restore a removed fact. Chunks are linked through a new `fact_id` column (default: the row's own `id`; pass `fact_id` on each chunk of a split fact). Tables written earlier get the column added on open, filled with `id`, so their rows match only an exact removal.

Breaking for direct callers: `LanceIndex.removeFacts` now requires a scope argument, so callers must pass `{ namespace, source }` along with the ids.
