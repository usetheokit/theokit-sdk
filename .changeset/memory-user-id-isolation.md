---
"@theokit/sdk": minor
---

`MemorySettings.userId` now partitions the memory store. When set, facts, the index and session summaries live under `<memory root>/users/<userId>/` and the agent reads only that partition, so agents sharing one directory no longer see each other's facts. An agent with `userId` set therefore reads and writes a new location; facts it recorded earlier in the unpartitioned root are not read. Agents without `userId` are unchanged. The `MemorySettings` TSDoc now states the real layout.
