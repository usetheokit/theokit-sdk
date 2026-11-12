---
"@theokit/sdk": patch
---

Muse stdio sessions no longer raise an uncaught `EPIPE` when a message is sent to a child that has already exited.
