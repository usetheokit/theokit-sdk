---
"@theokit/sdk": patch
---

`MEMORY.md` says, at both ends, which of two contracts it is.

The Claude Code CLI's is a plain file under its own home, capped at 200 lines / 25 KB on read and
swept on `cleanupPeriodDays`. This SDK's is the durable-memory subsystem — a SQLite+FTS5 store under
`.theokit/memory/`, with `memory_search` / `memory_get` tools, no index cap, and a different
directory entirely. Same filename, different directory, different semantics.

**A parity survey reported `CLAUDE_CONFIG_DIR` as absent; it is not.** Measured across both packages:
it is read in `claudeProjectMemoryDir`, which resolves the CLI's memory directory for interop, keyed
by git root. The original grep ran only against `@theokit/agents`, where it is genuinely absent, and
reported it absent everywhere — the third item in this release whose evidence was measured in the
wrong place or under the wrong name.

`CLAUDE_CONFIG_DIR`'s scope is now stated: it names the CLI's home so this reader finds the right
directory, and it relocates no user-level root of this product's own, because there is none — the
config roots resolved elsewhere are project-relative. A blank value is treated as unset rather than
as a root, pinned by a test: `CLAUDE_CONFIG_DIR=""` is what an unset shell variable expands to in a
wrapper script, and reading it as a root produces `/projects/…`, which exists on no machine and fails
silently as "the CLI has no memories here".

**What remains unimplemented, and why that is a decision.** `autoMemoryEnabled`,
`autoMemoryDirectory`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `cleanupPeriodDays` and the read cap have
no counterpart. Interop is one-way on purpose: a memory the CLI recorded stays visible, and this
runtime does not write into a store another product owns the lifecycle of. A `cleanupPeriodDays`
implemented here would delete files the CLI expects to find.

The filename is kept rather than renamed — one of the two is another product's, and renaming it here
would break the interop the reader exists for.
