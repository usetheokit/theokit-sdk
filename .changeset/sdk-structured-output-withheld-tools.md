---
'@theokit/sdk': minor
---

`Agent.generateObject` and `Agent.streamObject` accept `withheldBuiltinTools` and `memory`, forwarded to the transient agent each call creates. Pass `withheldBuiltinTools: ["shell"]` and `memory: { enabled: false }` for a JSON-only step that must hold no shell and write no transcript; the `output` tool stays available. With `structuringModel`, the reasoning-phase agent receives the same options. Without them nothing changes: the transient agent holds `shell` and writes a transcript as before.
