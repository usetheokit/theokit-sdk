---
"@theokit/sdk": minor
---

`Agent.sessionPool` keeps one agent per session key with per-key generations: `lease(key)`, `reset(key)` (next generation, old agent disposed once no turn holds it), `rebuild(key)` (same id, fresh options) and `disposeAll({ drainMs })`. Adds `memoryGenerations`, `jsonGenerations`, `SessionPoolClosedError` and `GenerationFileError`.
