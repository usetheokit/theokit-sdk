---
"@theokit/sdk": patch
---

`acquireInstanceLock` takes over a stale lock after crashed takers left guards behind (no 16-guard limit, no stuck takeover marker), cleans up only guards it still owns, and `release()` rejects when the unlink fails so a later call retries (#1191).
