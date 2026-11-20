---
"@theokit/sdk": patch
---

Tests: retry temp-folder removal in the throw-on-error helpers test so a late registry write no longer fails cleanup with ENOTEMPTY.
