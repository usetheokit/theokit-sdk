---
"@theokit/sdk": patch
---

The README documents the shape of `.theokit/hooks.json`, which it previously told a consumer to
validate against and did not show. The sentence *"read and validated here, against the shape above"*
had no shape above it — the section stated where the file is read from and never what goes in it, so
the one thing a consumer needs in order to exercise the gate that guards it was missing
(usetheokit/theokit-sdk#638).

What is documented is read from the loader rather than restated beside it: the JSON shape, the three
fields a hook entry may carry (`type`, `command`, `timeout`), the seven Claude Code fields refused
with a named error rather than dropped, the four events that actually fire, and the nested
`hookSpecificOutput.permissionDecision` deny shape with `ask` projecting to deny.

`tests/the-readme-hooks-shape-matches-the-loader.test.ts` holds it there, reading
`CLAUDE_CODE_EVENT_MAP`, `ACCEPTED_HOOK_FIELDS` and `UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS` from the
loader — the last two newly exported for that purpose, from a module that is already `@internal`, on
the precedent `CLAUDE_CODE_EVENT_MAP` set when it was exported so the supported set would be derived
rather than asserted.

Each list is read from its own sentence rather than from the section. The first version of the test
asserted the section contained `` `if` `` and passed after `if` was deleted from the refused list,
because the next sentence happens to mention it — a green assertion for a reason unrelated to its
claim, which is the same defect one level up.
