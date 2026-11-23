---
"@theokit/sdk": minor
---

`@theokit/sdk/workflow`: add `Workflow.fromDefinition(definition, { generate, persistence })` to compile a linear workflow described as data (prompt steps and approval steps), and `loadWorkflowDir(dir, options)` to load every `*.json` definition in a directory. An invalid file throws `WorkflowDefinitionError` naming the file and the offending field. Also exports `parseWorkflowDefinition` and the definition types.
