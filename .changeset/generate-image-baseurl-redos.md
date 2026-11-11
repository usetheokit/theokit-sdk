---
"@theokit/sdk": patch
---

`generateImage` no longer stalls on a `baseUrl` holding a long run of slashes: its trailing slashes are trimmed in one linear pass instead of with a backtracking regex (CodeQL `js/polynomial-redos`).
