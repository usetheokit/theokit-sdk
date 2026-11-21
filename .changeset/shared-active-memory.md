---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`@theokit/sdk-memory` now re-exports `runActiveMemory` and the `memory_search` / `memory_get` tool factories from `@theokit/sdk` instead of carrying copies. The SDK's versions add an abort signal, `memoryRoot`, diagnostics-sink error reporting and symlink-aware path containment.
