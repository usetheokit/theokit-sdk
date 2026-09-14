---
"@theokit/sdk": minor
---

A repo-root instruction file now requires a grant a consumer can write.

`DEFAULT_DISCOVERY_SPECS` carries four repo-root instruction files whose bodies enter the system
prompt as if we had written them — `AGENTS.md`, `GEMINI.md`, `CLAUDE.md` and `.cursor/rules/*.mdc`.
Until now exactly ONE spec in that file carried a gate, and it was `.claude/rules/*.md`. A cloned
repository's `.claude/rules/*.md` needed a declaration; the `CLAUDE.md` one directory up did not,
while both carried the same risk.

**The vocabulary landed before the gate, and the order is the whole point.** `CompatSource` went
from two literals to five:

```ts
compatSources: ["agents"]   // AGENTS.md is admitted; GEMINI.md is not
```

Gating the four against the OLD union would have gated three formats on a grant nobody could write
and made them permanently unreachable — worse than the gap. A test asserts the invariant in both
directions and fails the moment a spec is gated on a token the union does not carry.

**Separate literals, not one `foreign` token**, so a consumer who wants `AGENTS.md` is not forced to
also admit `.cursor/rules/*.mdc`.

**BREAKING for a consumer who declares nothing**: they went from four repo-root files in the prompt
to none. That is the intended behaviour and it is LOUD — `withheldSpecs` reports every withheld file
by path with the grant that restores it, and the runner warns once naming each one. A count would be
a diagnosis with no remedy: you cannot decide whether to grant a dialect without knowing which file
it brings.

`undefined` and `[]` stay distinct: no gate configured admits everything, an empty declaration
withholds every gated spec. Collapsing them would restore the defect the first gate closed.
