---
"@theokit/sdk": patch
---

A hook event the runtime does not fire is now reported even when the host installed no diagnostics
sink.

The loader maps four Claude Code event names and skips the rest. Skipping is honest — the runtime
genuinely does not fire the others — but the notice went through `warnOnce` → `diag`, and `diag` is
silent by default. So an operator declaring a `PreCompact` guard got nothing: no hook, no message,
and no way to learn either.

`diag`'s silence is right for chatter: a library must not assume the host's stderr is a free-form
log, because in a TUI it is the render surface. A configuration the operator **wrote** and this
runtime will not honour is not chatter. `warnFailureOnce` routes it through `diagFailure`, the
channel that already exists for exactly this and whose docblock records the precedent — `#189`,
where an MCP server failed to start, the only report went to `diag()`, the embedding UI never read
it, and "the user saw an agent with missing tools and no reason given".

A dropped hook is that shape with a sharper edge, because the missing thing is a guard: the operator
declared a refusal, it silently does not exist, and nothing distinguishes that from a refusal that
ran and approved.

A sink still takes precedence when one is installed — this only changes what happens when none is.

**A note for whoever writes the next test here.** `vitest.setup.ts` installs a stderr-forwarding
sink for the duration of every test, so the default path is the one shape this suite never
exercises. A test written the obvious way passes before the fix and proves nothing; the one added
here removes the sink in `beforeEach` to stand in for a consumer that never called
`setDiagnosticsSink`.
