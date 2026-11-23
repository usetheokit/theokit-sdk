---
"@theokit/sdk": major
---

`Agent.sessionPool` accepts an `agent({ key, agentId, context })` factory in place of `open`, `lease(key, context)` passes the caller's context to it (and to `open`), `SessionPool.heldIds()` lists the ids the pool still holds, and the pool warns once when held agents keep it above `maxOpen`.
