---
'@theokit/sdk': patch
---

Documentation: the `postRun` hook fires on a failed run, but it is internal-only. `.theokit/hooks.json` cannot register it (Claude Code has no per-run event), and `Stop` fires only on a finished run. `HookEvent` now says so.
