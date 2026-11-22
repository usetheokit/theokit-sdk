---
"@theokit/sdk": major
---

`@theokit/sdk/workflow`: `persistence.keepHistory` (with `durability: "step"`) keeps every checkpoint of a run; `workflow.history(runId)` lists them and `workflow.rerunFrom({ runId, stepId })` forks a new run from a top-level step, leaving the original run's history untouched. The new run carries `rerunOf`.
