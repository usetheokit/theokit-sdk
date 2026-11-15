---
"@theokit/sdk": minor
"@theokit/sdk-memory": patch
---

Add `listMemoryFacts`, `removeMemoryFact`, `StoredMemoryFact` and `MemoryFactNotRemovableError` for the built-in memory store. The public signatures take the public `MemorySettings` (mapped internally to the internal location config, which stays unexported). Entries outside the write root, such as the Claude Code CLI's store, are listed with `removable: false` and refuse removal.

`@theokit/sdk-memory` re-exports the two new internal store helpers (`listFactEntries`, `removeFactEntry`) to stay in step with the SDK store.

Removal does not touch the search indexes: the next `IndexManager.sync()` drops the sqlite entry (the corpus walk now also drops files that left the disk). A Lance index holds a copy from the one-time sqlite-to-Lance migration with no link to its source file, so its rows are not changed. Ids of entries outside the write root carry a root hash, so they never collide with a write-root file name. Two identical legacy bullets in one root share an id; removal takes the first.
