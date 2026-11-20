---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

The ten embedding provider adapters now live only in `@theokit/sdk`; `@theokit/sdk-memory` re-exports them from `@theokit/sdk/internal/memory-adapters`, so an adapter fix no longer has to be applied twice.
