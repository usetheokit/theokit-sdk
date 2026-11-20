---
"@theokit/sdk": major
---

Refresh the API-surface baseline for `Workflow` and `WorkflowSnapshot`: `WorkflowSnapshot._schemaVersion` now admits `3`, with an optional `status`, and `WorkflowPersistenceOptions` gains `durability` (step checkpoints from #1096).
