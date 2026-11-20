---
"@theokit/sdk": minor
---

`@theokit/sdk/workflow`: `compensate` now works on top-level function steps. When a top-level step fails, earlier completed steps' `compensate` handlers run in reverse order; results are on `WorkflowRun.compensation` and `Workflow.stream()` emits `step_compensated` / `step_compensation_failed`. A `compensate` nested in `parallel`, `branch`, `foreach` or `dowhile` still fails with `WorkflowCompensateNotImplementedError`.
