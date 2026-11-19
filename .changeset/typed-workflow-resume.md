---
"@theokit/sdk": minor
---

`Workflow.resume` and `workflowResumeTool` accept a committed workflow with a typed input without a cast. `Workflow.resume` gains a second type parameter `TI`, inferred from `workflow`.
