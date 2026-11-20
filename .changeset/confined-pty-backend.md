---
"@theokit/sdk-pty": minor
---

Add `createConfinedPtyBackend` (root-forced cwd, sandbox wrap, scrubbed environment) and `probeConfinement`, which proves on this host that the confinement works and returns the reason when it does not (#1040).
