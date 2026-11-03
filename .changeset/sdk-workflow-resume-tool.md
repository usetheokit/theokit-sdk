---
'@theokit/sdk': minor
---

A model can now continue a suspended workflow run. `workflowAsTool` used to raise `WorkflowToolError`
for a run that suspended and never handed the model the run id, and no tool called `Workflow.resume`.
Its spec gains an opt-in `reportSuspended`: a suspended run then returns
`{"status":"suspended","runId":"…","stepId":"…"}`, ids only, never the suspended payload. The new
`workflowResumeTool(workflow, { name, description, reportSuspended? })`, exported from
`@theokit/sdk/workflow`, resumes that run by id with an optional payload validated against the suspend
step's schema, and returns the run's output. The run id stays the same across resumes, so a second
suspension is told apart by its `stepId`. Without the opt-in a suspended run still raises. The tool
resumes any run id it is given: who may approve a run is the host's decision. The default snapshot
store is in memory and process-local.

`Workflow.resume`, and so the resume tool, now refuses a run id whose snapshot was written by a
workflow of another name with the typed `WorkflowResumeWorkflowMismatchError` and leaves the snapshot
for the workflow that suspended it. Before, a workflow sharing the suspended step id ran its own tail on
the other workflow's input. A report's `stepId` is `null` for a run that carries no step result.
