---
"@theokit/sdk": minor
---

`@theokit/sdk/persistence` exports `acquireInstanceLock`, `InstanceLock` and `InstanceLockedError`: a lock on `<dir>.instance.lock` held for the life of the process, so one process runs per state directory. A lock left by a crashed process is taken over, and only one of several racing processes wins. Liveness is `kill(pid, 0)`, so contenders must share a pid namespace.
