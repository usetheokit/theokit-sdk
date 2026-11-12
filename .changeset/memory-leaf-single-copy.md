---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`@theokit/sdk-memory` re-exports the index schema, database opener, vector index, markdown chunker, bounded reader and active-memory cache and types from `@theokit/sdk/internal/memory-store` instead of carrying a second copy of each.
