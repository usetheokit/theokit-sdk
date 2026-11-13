---
"@theokit/sdk": patch
---

Memory search now falls back to a LIKE scan when a CJK query returns no FTS rows, so a CJK substring is found in a healthy index and not only when the FTS statement throws.
