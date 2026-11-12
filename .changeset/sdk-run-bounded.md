---
"@theokit/sdk": minor
---

Add `@theokit/sdk/process` (`runBounded`). A timed-out or aborted hook or `shell` tool call now kills its whole process group on POSIX, and each output stream is capped (default 5 MiB) with a `truncated` flag.
