---
"@theokit/sdk": patch
---

`close()` followed by `dispose()` (or `await using`) on a local agent now tears the session down. Previously `close()` marked the agent disposed, so `dispose()` returned without aborting the in-flight request, releasing MCP clients, flushing writes or releasing the session lease.
