---
"@theokit/sdk": minor
"@theokit/sdk-memory": patch
---

Add `listMemoryFacts`, `removeMemoryFact`, `StoredMemoryFact` and `MemoryFactNotRemovableError` for the built-in memory store. The public signatures take the public `MemorySettings` (mapped internally to the internal location config, which stays unexported). Entries outside the write root, such as the Claude Code CLI's store, are listed with `removable: false` and refuse removal.

`@theokit/sdk-memory` re-exports the two new internal store helpers (`listFactEntries`, `removeFactEntry`) to stay in step with the SDK store.

Removal also updates the search indexes: the sqlite index is re-synced (deleted files leave it, an edited `MEMORY.md` is re-chunked), and Lance `memory` rows holding the fact are deleted or rewritten without it (open handles are refreshed), so recall does not return a removed fact. Ids of entries outside the write root carry a root hash, so they never collide with a write-root file name. Two identical legacy bullets in one root share an id; removal takes the first.
