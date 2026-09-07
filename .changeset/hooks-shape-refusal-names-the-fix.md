---
"@theokit/sdk": patch
---

A wrongly-shaped `hooks` block is refused with the shape that would work

`hooks: expected an object at "hooks" in <path>` named the validator's expectation and nothing an operator could act on. It now carries the accepted shape:

```
hooks: expected an object at "hooks" in <path> — hooks are keyed by event,
e.g. { "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "…" } ] } ] } }
```

Measured on a consumer in 2026-09. A flat `hooks` array in a `.theokit/settings.json` made this loader throw on **every turn** — and the file parsed perfectly for the product that had written it. `.theokit/` is this package's filebase, so what failed was an independent read of a path another product had started using, and the collision was one of **shape**, not of location. With only the diagnosis to go on, the operator looked in the wrong file.

Two tests ship with it: the refusal names the shape, and a control proves the shape it names is accepted. Without the control, "the error mentions `keyed by event`" would say nothing about whether that advice is correct.
