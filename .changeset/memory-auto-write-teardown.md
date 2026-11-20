---
"@theokit/sdk": patch
---

Tests: prove that disposing an agent waits for a pending session write, so the memory-auto-write golden test no longer races the per-test home removal with ENOTEMPTY.
