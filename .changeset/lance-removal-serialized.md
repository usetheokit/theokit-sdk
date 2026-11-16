---
"@theokit/sdk": patch
---

`LanceIndex.removeFacts` now removes every chunk of a fact (`<id>#<n>`) and nothing else, and runs after any `addFacts` already in flight, so a concurrent sync can no longer restore a removed fact.
