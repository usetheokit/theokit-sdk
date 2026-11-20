---
"@theokit/sdk": major
---

Workflow: `persistence.keepHistory` (with `durability: "step"`) retains every checkpoint of a run. `workflow.history(runId)` lists them and `workflow.rerunFrom({ runId, stepId })` re-runs from a top-level step as a new run, restoring that point's output and shared state and leaving the original history untouched. The new run's `WorkflowRun` carries `rerunOf`.
