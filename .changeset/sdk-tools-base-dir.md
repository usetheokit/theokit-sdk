---
"@theokit/sdk": patch
"@theokit/sdk-tools": minor
---

`createWriteFileTool`, `createEditFileTool` and `createApplyPatchTool` accept `baseDir`: the base for relative paths, separate from the `projectRoot` boundary. A `baseDir` outside `projectRoot` throws `BaseDirOutsideProjectRootError` at construction.
