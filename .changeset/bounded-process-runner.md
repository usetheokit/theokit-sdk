---
"@theokit/sdk": minor
---

New `@theokit/sdk/process` entry exporting `runBounded`. On timeout or abort it kills the whole process group on POSIX (a timed-out hook or `shell` tool call no longer leaves pipelines or background jobs running) and caps each output stream at `maxOutputBytes` (default 5 MiB) with a `truncated` flag. `spawnAndCollect`, and so hooks and the `shell` tool, now use it; truncated output gets a trailing `[output truncated]` note.
