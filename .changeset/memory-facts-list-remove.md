---
"@theokit/sdk": minor
"@theokit/sdk-memory": patch
---

Add `listMemoryFacts`, `removeMemoryFact`, `StoredMemoryFact` and `MemoryFactNotRemovableError` for the built-in memory store. The public signatures take the public `MemorySettings` (mapped internally to the internal location config, which stays unexported). An id found in more than one root rejects with `MemoryFactAmbiguousError` and removes nothing. Entries outside the write root, such as the Claude Code CLI's store, are listed with `removable: false` and refuse removal.

`@theokit/sdk-memory` re-exports the two new internal store helpers (`listFactEntries`, `removeFactEntry`) to stay in step with the SDK store.

Removal also deletes the entry's rows from the sqlite search index (and the corpus sync now prunes rows of files that left the disk), so recall does not return a removed fact. Removal runs under the store's lock, which `IndexManager.sync` also takes. The built-in store feeds only the sqlite index, so a Lance index is not touched. Two identical legacy bullets in one root share an id; removal takes the first.
