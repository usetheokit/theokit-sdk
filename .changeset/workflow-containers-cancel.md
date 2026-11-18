---
"@theokit/sdk": patch
---

Workflow containers report cancellation correctly: a `foreach` item that cancels itself aborts its siblings and the step resolves `cancelled`, and a `parallel` whose signal aborts while its last branch function runs resolves `cancelled` under both error policies instead of `completed`.
