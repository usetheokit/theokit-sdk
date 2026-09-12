---
"@theokit/sdk": minor
---

`AGENTS.local.md`, `CLAUDE.local.md` and `THEO.local.md` are discovered, and composed last.

The gitignored companion is where an operator keeps the standing corrections too personal or too
situational to commit. Nothing discovered it. Measured 2026-09-12: a grep for the four `.local`
spellings returned **0 files** across this package's source, against a control of 23 for
`CLAUDE.md`. The failure is the silent kind — the file exists, it is named the documented way,
nothing loads it, and nothing complains, so the agent behaves exactly as it would if the operator
had written nothing.

**Order, and the cost of it, stated rather than discovered later.** The three specs sit above every
public one (priorities 70/75/80) because a correction has to be composed after the rule it corrects,
and they keep the public chain's relative order among themselves so both halves read the same way.
`applyAggregateCap` fills the budget in ascending priority, so the highest numbers are the first
dropped when the total cap is reached — placing the private chain last therefore makes it the first
to go under pressure. The alternative, a low number to protect it, would compose the operator's
refinement *before* the general rule and invert its meaning, which is the defect this closes. The
table already accepts that trade: `.theokit/THEO.md`, the most specific public file, sits at 60 and
is equally droppable.

**Three and not six.** A private companion pairs with a public file this seam reads, and the
documented convention is THEO / AGENTS / CLAUDE. `GEMINI.local.md` and a private `.cursor/rules` are
not part of it, and inventing them would publish a convention nobody writes.

**Ungated**, like the repo-root files beside them. `CLAUDE.local.md` sits at the repository root
rather than inside `.claude/`, so it follows `CLAUDE.md` and not `claude-rules` — the grant added in
#652 gates the foreign *root*, not the files beside it.

The chains stay independent: a private file never replaces its public sibling. One falling back to
the other is the trap, where adding a `THEO.md` would silently orphan an existing `AGENTS.local.md`.
