---
"@theokit/sdk": patch
---

`LanceIndex.removeFacts` now runs after any write already in flight on the same index, so removed facts are not re-added, and takes an optional `{ namespace, source }` scope; `removeFacts(ids)` still works unchanged (#1206).
