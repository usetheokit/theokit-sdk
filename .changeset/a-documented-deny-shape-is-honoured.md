---
"@theokit/sdk": patch
---

A hook emitting the **documented** deny shape is now honoured instead of being read as `allow`.

`hooks-source.ts` advertises a config shape "identical to Claude Code's `settings.json` hooks", so a
consumer writes the guard that documentation specifies:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…"
  }
}
```

`parseDecisionFromStdout` read only a **top-level** `decision` and accepted only
`deny` / `feedback` / `allow`. The nested shape has no top-level `decision` at all, so it fell past
every branch to the final `return { decision: "allow" }`. The JSON parsed, nothing warned, and the
tool call proceeded.

Measured against four inputs before the fix: the documented shape → allow; the deprecated-but-
documented `{"decision":"block"}` → allow; `Stop` with `block` → allow; only this runtime's own
`{"decision":"deny"}` denied.

Three spellings mean deny and all three are now read: the nested `permissionDecision`, the
deprecated `block`, and the native `deny`. A nested `ask` projects to deny — collapsing it to allow
would be the same fail-open one value over, since this runtime has no third state to put the
question to.

**Deliberately unchanged**: an unrecognised shape still resolves to `allow`. Making it deny would
refuse every hook that prints diagnostics and happens to emit JSON — a behaviour change with its own
blast radius, and its own measurement. The three documented denials are unambiguous; that case is
not.

The direction is what made this expensive. A missing hook event is discoverable: the user sees
nothing happen and investigates. A veto that silently does not fire is indistinguishable from a veto
that fired and approved.
