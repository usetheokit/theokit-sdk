---
"@theokit/sdk": patch
---

A `model.params` entry with id `reasoning` or `reasoning_effort` no longer switches off
`reasoning: true`. Only `thinking` is sent to the provider as a reasoning effort, so these two ids
used to count as native reasoning without being forwarded: the run got neither the provider effort
nor the reasoning preamble and `think` tool, and no error. `reasoning: true` now applies to such a
model. To request native reasoning, use `{ id: "thinking", value: "high" }`.
