---
"@theokit/sdk": minor
---

Add `listMemoryFacts` and `removeMemoryFact` for the built-in memory store, with `StoredMemoryFact` and `MemoryFactNotRemovableError`. The public signature accepts `MemorySettings` (only `directory` and `userId` are read) and maps it to the internal location config; the internal type is not exported. Removal deletes a per-memory file and its index line, or one legacy `## Facts` bullet, under the writer's mutex. The next memory search index `sync()` now drops the chunks of a file that left the memory root, so a removed fact stops being recalled.
