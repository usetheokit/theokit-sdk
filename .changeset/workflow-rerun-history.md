---
"@theokit/sdk": major
---

Workflow: `persistence.keepHistory` (with `durability: "step"`) keeps every checkpoint of a run; `workflow.history(runId)` lists them and `workflow.rerunFrom({ runId, stepId })` forks a new run from an earlier top-level step, leaving the original run's history untouched.
