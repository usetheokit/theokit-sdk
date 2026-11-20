---
"@theokit/sdk": minor
---

`SandboxBackend` gains `uploadFiles(files)`, which writes several files in one call. The default loops over `uploadFile`; a remote backend can override it to send one request.
