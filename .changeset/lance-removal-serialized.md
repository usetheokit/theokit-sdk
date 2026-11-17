---
"@theokit/sdk": patch
"@theokit/sdk-memory": minor
---

`LanceIndex.removeFacts` now removes every chunk of a fact (`<id>#<n>`) and nothing else, and runs after any `addFacts` already in flight, so a concurrent sync can no longer restore a removed fact.

Breaking for direct callers: `LanceIndex.removeFacts` now requires a scope argument, so callers must pass `{ namespace, source }` along with the ids.
