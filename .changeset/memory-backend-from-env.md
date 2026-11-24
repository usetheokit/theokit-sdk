---
"@theokit/sdk-memory": minor
---

Add `memoryBackendFromEnv(env, { variable?, importer? })`: picks `mem0`, `honcho`, `supermemory` or `sdk-memory` from `THEOKIT_MEMORY_BACKEND` (or another variable), checks the API key, and lazily imports the adapter in `agentOptions()`. Errors are `ConfigurationError`s naming the missing key, package or peer.
