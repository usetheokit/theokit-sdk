---
"@theokit/sdk": patch
---

Export the memory index and store leaf modules (schema, database opener, vector index, chunker, reader, active-memory cache and types) from `@theokit/sdk/internal/memory-store` so `@theokit/sdk-memory` can re-export them instead of copying them.
