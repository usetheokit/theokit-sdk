---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`@theokit/sdk-memory` now re-exports `runActiveMemory` and the `memory_search` / `memory_get` tool factories from `@theokit/sdk` instead of carrying copies, so a fix to one reaches users of the other. The SDK's recall and tool options now accept any index that has `search`.
