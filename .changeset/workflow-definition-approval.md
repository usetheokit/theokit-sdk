---
"@theokit/sdk": minor
---

`WorkflowDefinition` takes an optional `description` (kept by `Workflow.describe()`), an approval step takes `decision: "approved"` (resume with `{ approved: boolean }`; `false` completes the run), and `loadWorkflowDir` takes `onInvalid` to skip and report bad files instead of throwing.
