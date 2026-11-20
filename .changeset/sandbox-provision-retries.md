---
"@theokit/sdk": minor
---

`provisionRepo` accepts `timeoutMs` (per clone attempt) and `attempts` (default 1); a failed clone is retried after the partial `instanceId` directory is removed.
