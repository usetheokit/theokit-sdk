---
"@theokit/sdk": patch
---

Muse stdio transport: a write to a child that already exited no longer raises an uncaught `EPIPE`; the turn fails with the typed `provider_unreachable` error.
