---
"@theokit/sdk": patch
---

Align permission rule wildcards with Claude Code: a trailing `:*` now reads as the command before it (`Bash(npm run test:*)` matches `npm run test` and `npm run test --watch`, not `npm run test:unit`), and `**/` in a path glob matches whole directories only.
