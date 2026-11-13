---
"@theokit/sdk": minor
---

Add `listMemoryFacts`, `removeMemoryFact`, `StoredMemoryFact` and `MemoryFactNotRemovableError` for the built-in memory store. The public signatures take the public `MemorySettings` (mapped internally to the internal location config, which stays unexported). Entries outside the write root, such as the Claude Code CLI's store, are listed with `removable: false` and refuse removal.
