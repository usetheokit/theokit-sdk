---
"@theokit/sdk": minor
---

Add `Agent.sessionPool`: one agent per session key with per-key generations (`reset`), same-id `rebuild`, idle and `maxOpen` retirement, and a drained `disposeAll`. Also exports `memoryGenerations`, `jsonGenerations`, `SessionPoolClosedError` and `GenerationFileError` (#1017).
