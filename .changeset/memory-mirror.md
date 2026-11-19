---
"@theokit/sdk": minor
---

Add `memory.mirror` (`MemoryMirrorOptions`): write every fact the built-in store saves through to the agent's `kind: "memory"` adapters, and optionally build the `<memory>` block from them first (`recall: "adapters-first"`), with local facts as the fallback. Adapter write failures are reported on the diagnostics channel with the adapter id and never fail the save or the run.
