---
"@theokit/sdk": patch
---

The identity-store test reads the identity file through one descriptor instead of checking its mode by path and then reading it by path.
