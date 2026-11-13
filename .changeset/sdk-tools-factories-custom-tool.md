---
"@theokit/sdk-tools": patch
---

`createTodolistTool()` and `createPlanModeTool()` now return types assignable to `CustomTool`, so they go straight into `AgentOptions.tools` without `as unknown as CustomTool`. Types only: `inputSchema` is `Record<string, unknown>` and `handler` takes `Record<string, unknown>`; runtime behavior and results are unchanged.
