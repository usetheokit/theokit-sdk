---
"@theokit/sdk": patch
---

The `meta/*` Muse provider now resolves the `muse` binary to an absolute path from absolute `PATH` entries before spawning it, so a relative or empty `PATH` entry can no longer pick the executable.
