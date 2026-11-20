---
"@theokit/sdk": minor
---

Add `WorkflowSet.of(workflows).resume(runId, payload?)` to `@theokit/sdk/workflow`: it resumes a run id on the workflow that owns it, skips only "not this workflow" errors, rethrows every other error, and throws `WorkflowSnapshotNotFoundError` when no member owns the run (#1030).
