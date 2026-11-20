---
"@theokit/sdk": patch
"@theokit/sdk-memory": patch
---

`@theokit/sdk-memory` re-exports `runActiveMemory` and the `memory_search` / `memory_get` tool factories from `@theokit/sdk` instead of carrying copies (#1069). Every public name is unchanged. Recall errors now go to the SDK's diagnostics sink rather than directly to stderr; pre-aborted signals and custom transcript roots are now honoured, and `memory_get` containment resolves symlinks.
