---
"@theokit/sdk": patch
---

Document that `on_session_start` / `on_session_end` fire once per **run** (#613 follow-up)

Docs and a test only; no behaviour change.

`SessionLifecycleContext` is named for a session and carries a `runId` that changes on every firing. The hooks fire once per pass through the agent loop — which is per-message for any application that builds its agent per turn. Nothing a consumer could read said so: the only accurate sentence was an internal comment at the firing site (`loop.ts`, *"fires once per run"*).

That gap was measured. In 2026-09 it cost two sessions several hours and produced a defect filed against this package for behaviour that is correct; the real answer turned out to be an architectural mismatch in a consumer that constructs an agent per turn, where "once per run" is not what a `SessionStart` handler assumes.

Two changes:

- The cadence is now stated on `SessionLifecycleContext` and in the `HookName` docblock, where a consumer meets the hook.
- `test_on_session_start_fires_once_per_run_and_again_on_the_next_run` pins it across two runs. The existing integration case could not: it collects into a `Set`, so a hook firing twice and a hook firing once are indistinguishable there by construction.
