---
"@theokit/sdk": minor
---

The pre-compaction seam now reaches the compaction path a consumer actually calls.

There are three compaction paths in this ecosystem. `withPreCompaction`, shipped in
`@theokit/agents@14.1.0`, covers one of them — the agents-layer strategy. The other two are
`autoCompactIfNeeded` and `Agent.compact(sessionId, { trigger })`, and **the second is the one a
person reaches**: `/compact` → `handleCompact` → `compactSession` → `Agent.compact`.

```ts
await Agent.compact(agentId, {
  trigger: "manual",
  onPreCompact: async ({ messages, trigger, signal }) => {
    await archive(messages, { because: trigger })   // runs BEFORE the transcript is rewritten
  },
  onPreCompactError: (e) => report(e),              // compaction proceeds either way
})
```

**One seam covers both SDK paths** because they converge on `compactSessionTranscript`. A seam per
caller would need each one to choose, and a caller that chooses wrong reintroduces the gap.

**`trigger` is received, not inferred.** It already existed in the options and already reached the
compaction boundary; the handler is simply told. Inferring it from the call site would be right today
and silently wrong the first time a third caller appears.

**Failure never blocks compaction.** A handler that throws is reported; one that exceeds its bound is
abandoned with its `AbortSignal` aborted first, so it can stop rather than be left running. A hook
that could block would turn a consumer's bug into a runtime that cannot reclaim its context.

**Nothing changes for a consumer who registers nothing** — the seam is not entered, asserted by a
test rather than left as an inference.
