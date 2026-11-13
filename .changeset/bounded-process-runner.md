---
"@theokit/sdk": minor
---

New `@theokit/sdk/process` entry exporting `runBounded`. On POSIX a timeout or abort now kills the whole process group, and output is capped per stream (5 MiB default) with a `truncated` flag. Hooks and the built-in `shell` tool use it, so a timed-out command no longer leaves its child processes running; a truncated `shell` stream gets a trailing `[output truncated]` note.
