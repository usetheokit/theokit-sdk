---
"@theokit/sdk": patch
---

Export `IndexManager`, its backend dispatch, `LanceIndex`, `LanceMemoryAdapter` and the two migrations (`migrateSqliteToLance`, `migrateLegacyJson`) from `@theokit/sdk/internal/memory-store` so `@theokit/sdk-memory` can re-export them instead of copying them.
