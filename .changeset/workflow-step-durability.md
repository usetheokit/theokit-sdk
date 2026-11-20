---
"@theokit/sdk": minor
---

`@theokit/sdk/workflow`: `persistence.durability: "step"` checkpoints a run after every completed top-level step, so `Workflow.resume({ runId })` can continue a run that crashed. A completed run deletes its checkpoint. New `workflow.listRuns()` lists suspended and running snapshots. Snapshot schema v3 adds `status`.
