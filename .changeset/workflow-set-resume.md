---
"@theokit/sdk": minor
---

Add `WorkflowSet.of(workflows).resume(runId, payload?)` to `@theokit/sdk/workflow`: it resumes a run on the member workflow that owns it. Only `WorkflowSnapshotNotFoundError` and `WorkflowResumeWorkflowMismatchError` count as "not this one"; every other error is rethrown unchanged, and an unknown id throws `WorkflowSnapshotNotFoundError`.
