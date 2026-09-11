---
"@theokit/sdk": patch
---

The hook loader stops claiming parity it does not have, and states the set it does.

The module docblock advertised a config shape "identical to Claude Code's `settings.json` hooks". The
SHAPE is identical; the event COVERAGE is four of the thirty-three documented events. Measured by
execution — a `hooks.json` declaring all thirty-three, through the shipped loader, yielded
`PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. Thirteen of the sixteen the spec marks
"Can block? Yes" were among the missing.

**The map is deliberately not grown.** Mapping a name the runtime does not fire is strictly worse
than refusing it: an operator declaring `PreCompact` today gets a report saying it will not fire;
with the name mapped they would get silence and a guard that never runs — a declared veto that does
not exist. The map grows when the seam exists, one event at a time.

`CLAUDE_CODE_EVENT_MAP` is now exported so the supported set is stated rather than implied, and a
test derives its expectation from it: adding a seam turns that test red, which is where the docblock
claim gets updated with it. The same test lists the fourteen unwired blocking events in priority
order — an unwired veto loses a capability, an unwired observer loses a signal — so the next person
picking one up does not re-derive which is which.

`postRun` has no entry on purpose: it fires per RUN, and no documented Claude Code event means that.
`SessionEnd` is the near miss, and a session is not a run.
