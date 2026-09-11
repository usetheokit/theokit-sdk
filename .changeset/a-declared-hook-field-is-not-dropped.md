---
"@theokit/sdk": patch
---

A hook field this runtime does not implement is now refused instead of dropped in silence.

`parseClaudeCodeCommand` read `type`, `command` and `timeout` and discarded everything else on the
entry — `if`, `args`, `statusMessage`, `once`, `async`, `asyncRewake`, `shell` — with no error and
no warning.

**`if` is the field that makes this a defect rather than a missing feature.** For the others the
loss is a convenience. For `if` it is the opposite of what the operator wrote: a deny hook narrowed
to one dangerous command shape silently becomes a deny hook over *every* call of that tool. The
guard still runs, so nothing looks broken; it simply applies where it was told not to.

The fix is refusal, not implementation. Implementing `if` means adopting a condition language whose
semantics nobody here has decided; refusing the field costs one throw and cannot be wrong about what
the operator meant. The direction is what matters — a dropped `if` fails open, a refused `if` fails
closed and names the field that stopped the load.

`packages/agents`, reading the same file one layer up, already took this side: its `hookSpecSchema`
is `.strict()` and refuses an unknown key loudly. Two layers disagreed about whether a field was an
error, and the permissive one was the layer that actually ran the hook.

The error separates "a Claude Code hook field this runtime does not implement" from "never heard of
this", and lists the siblings that will behave the same way — so an operator migrating a `.claude/`
tree does not learn one key per round trip. A non-command `type` still fails for its own reason: the
new check runs after the existing ones.
