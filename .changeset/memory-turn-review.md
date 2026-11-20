---
"@theokit/sdk": minor
---

Add `memory.review`: after each finished turn a serial, isolated reviewer agent saves durable facts through a `save_memory({ fact })` tool into the agent's own memory partition, with `agent.memory.reviewsIdle()` to wait for the queue (#1026).
