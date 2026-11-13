---
"@theokit/sdk": minor
---

New `@theokit/sdk/process` entry exporting `runBounded`. A timed-out or aborted command now has its whole process group killed (POSIX), and stdout/stderr are capped at `maxOutputBytes` (default 5 MiB) with a `truncated` flag. The `shell` tool and `sh -c` hooks use it, so a timeout no longer leaves pipelines or background jobs running; a truncated stream gets a trailing `[output truncated]` note.
