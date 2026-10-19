---
'@theokit/sdk': minor
'@theokit/sdk-memory': minor
---

Memory can now be given a fact ceiling. Once the store is full, a new fact is refused with a
typed error. Before this, nothing stopped the store growing, and the one cap that did exist, 500
facts per dreaming sweep, left the rest out of clustering while the result still said
`status: "ok"`.

Set `memory.maxFacts` on an agent to declare a ceiling. A new fact at or over it is refused with a
`ConfigurationError` whose code is `memory_ceiling_reached`, and nothing is written. The message
gives the directory, how many facts it holds, the ceiling and what to consolidate. Recording a fact
that is already stored counts as a second observation, not a new fact, so it is still admitted. A
value that is not a positive integer is refused with `invalid_memory_ceiling` by `Agent.create`
and `Agent.resume`, before the agent exists, and again by the writer before anything touches
disk. A prompt-driven memory write that hits the ceiling reports it on one diagnostic line and
stores nothing. With no ceiling declared, nothing changes and no extra read happens.

The ceiling holds across processes. Every SDK process that writes one memory directory with a
ceiling takes a lock (`<directory>.lock`, beside the directory) around the count and the write, so
two processes one fact below the ceiling no longer both get in. The lock needs the optional
`proper-lockfile` peer. Without it the ceiling holds within one process only, and the SDK says so
once on its diagnostics channel. A writer that declares no ceiling, such as the Claude Code CLI,
takes no lock and can still add facts past it.

A resumed agent keeps its ceiling and its `memory.directory`. The directory is now saved with the
agent, and a `memory` object passed to `Agent.resume` replaces only the fields it sets (a field
set to `undefined` keeps its persisted value). Before
this, `Agent.resume(id, { memory: { enabled: true } })` came back with no ceiling, and any resumed
agent wrote to the default store instead of the directory it was created with.

`createInMemoryMarkdownProvider({ maxFacts })` in `@theokit/sdk-memory` applies the same ceiling
to the adapter's `write` and to the `memory_remember` tool. Each handle counts its own facts.

`DreamingSweepResult` gains `factsLeftOut`, the number of deduplicated facts past the 500-fact
cap that a sweep did not cluster. It is reported on both dispatch paths, the `@theokit/sdk-memory`
peer and the SDK's own fallback. It is 0 on a skipped sweep and absent on a failed one. It is also
absent when an older `@theokit/sdk-memory` runs the sweep, because that version cannot count it,
so read absence as unknown, not as 0. `ClusterResult`, which `@theokit/sdk-memory` exports, now
requires `factsLeftOut` too. Code that builds its own `ClusterResult`, such as a mock of
`remPhase`, has to add it.

`@theokit/sdk-memory` now needs `@theokit/sdk` `>=5.10.0`, the first release that exports the
ceiling helpers it imports.
