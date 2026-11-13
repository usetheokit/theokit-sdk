---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`@theokit/sdk-memory` re-exports eight leaf modules from `@theokit/sdk/internal/memory-store` instead of carrying a second copy of each: the index schema, database opener, sqlite-vec loader, vector index, markdown chunker, bounded reader, and active-memory cache and types. `index-manager-contract` and `memory-index` stay local (see below).

Not shared: the SDK's `IndexStatus.countsExact` and `SyncResult.supported` are required fields that `sdk-memory`'s Lance adapter and index manager do not set. The SDK types were not loosened; those two modules move once the Lance and index-manager modules do.
