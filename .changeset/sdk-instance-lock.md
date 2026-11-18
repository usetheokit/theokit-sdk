---
"@theokit/sdk": minor
---

Add `acquireInstanceLock`, `InstanceLock` and `InstanceLockedError` to `@theokit/sdk/persistence`: a lock held for the life of the process so only one process runs per state directory, with takeover of a lock left by a crashed holder (#1045).
