---
'@theokit/sdk': patch
---

States, next to the write floor that does exist, that there is no read-side equivalent — and pins it
with a test so the claim and the behaviour cannot drift apart.

`permissionFloorReason` refuses a WRITE into `.claude/`, `.theokit/`, `.ssh` or `.gnupg` under every
allow rule. A READ of the same paths is refused by nothing: reads are governed by the rule language
and by nothing above it. `Read(path:./.env)` works and deny-before-allow means a deny cannot be
overtaken — but every such rule has to be written, nothing is refused by default, and a bare `Read`
allow grants reading any path the process can open.

The asymmetry was invisible from the module. `PROTECTED_SEGMENTS` reads like a list of protected
paths and is only half that: `.ssh` cannot be written through any rule, and can be read through an
ordinary allow.

`additionalDirectories` — the reference's key for an operator to WIDEN what an agent may read — has
no equivalent, and cannot have one while there is no fence to widen. Measured: zero occurrences in
this package and zero in `@theokit/agents`.

No fence was added, and not because one is unwanted. `permissionFloorReason` sees a tool name and an
argument map; a fence matching on those alone would miss every read that reaches the filesystem
another way — a shell command, a plugin, an MCP server. Shell reads are already confined by
`SandboxMode`, and a second containment vocabulary here would leave two answers to "may this be
read" that disagree at the edges. Deciding which layer owns that boundary is a measured decision,
not a docblock.
