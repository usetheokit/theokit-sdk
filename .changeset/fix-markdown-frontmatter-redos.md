---
"@theokit/sdk": patch
---

Replace the backtracking frontmatter regular expression in the markdown config loader with a linear scan, removing a polynomial-time (ReDoS) path on long whitespace runs.
