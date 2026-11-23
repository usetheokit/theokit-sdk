---
"@theokit/sdk": minor
---

`readSessionMessages` and `readSessionHistory` accept `scope: "all"` to return every message record in file order, including both sides of a compaction boundary and every branch. The default `"active-chain"` is unchanged.
