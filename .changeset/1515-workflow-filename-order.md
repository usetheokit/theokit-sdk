---
"@theokit/sdk": patch
---

Workflow definition files in a directory now load in alphabetical filename order (`localeCompare`, `en`), so `B.json` follows `a.json` instead of preceding it.
