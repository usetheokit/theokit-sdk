---
"@theokit/sdk": patch
---

The order nested instruction files reach the prompt is pinned, and the one real divergence from the spec is stated.

A parity survey reported three defects here. Re-measured by execution, two did not hold:

- **`.claude/rules/*.md` is read** — spec `claude-rules`, priority 47. A probe through `runDiscovery`
  over a temp project returned one source carrying the rule. The original zero-file grep was against
  a layer that does not do the reading.
- **Precedence is not reversed.** `walkUpForFile` returns nearest-first, and that is not what the
  model sees: `applyAggregateCap` re-sorts by priority and then by absolute path, so a three-level
  project measured `walk=[DEEP,SUB,ROOT]` and `prompt=[ROOT,SUB,DEEP]` — the spec's root-down order,
  where the nearer file refines the wider one instead of being buried under it.

**The correct behaviour was correct by accident**, which is why this changeset exists. Root-down falls
out of a tie-break written for prompt-cache determinism (EC-J), and nothing stated it. Change the
tie-break, or name a subdirectory lexically smaller than its parent, and a repository-wide
instruction starts being read after the nested one meant to refine it — with nothing to catch it. It
is now pinned by a test that also mutation-checks the inverse.

**The divergence that is real:** the walk stops at the git root, while the spec continues to every
directory above cwd. Kept, with the reason — a `CLAUDE.md` in a home directory or in `/tmp` would
silently apply to every repository underneath it, and an instruction file nobody in the project wrote
is the one case where finding more is worse than finding less. The operator-home question stays a
deliberate, separate decision rather than a side effect of how far a loop runs.
