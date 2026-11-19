---
"@theokit/sdk": minor
---

Add `memory.review`: after each finished turn an internal reviewer saves durable facts with a `save_memory` tool, one review at a time per agent. Adds `MemoryReviewOptions` and `agent.memory.reviewsIdle()` (#1026).
