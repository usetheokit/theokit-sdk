---
"@theokit/sdk": minor
"@theokit/sdk-memory": minor
---

`sessionSearchTool({ transcriptsDir, partition })` is exported from `@theokit/sdk-memory`: a `session_search` tool that word-matches the turns of earlier sessions and returns each with its session key and time. Only turns of the given partition are returned. To make that possible, `SessionRecord` gains an optional `memoryPartition`, which the SDK stamps from `memory.userId` on the records it writes; records written before this change carry none and are not searchable.
