---
"@theokit/acp": patch
"@theokit/sdk-handoff": patch
---

`@theokit/acp` and `@theokit/sdk-handoff` keep answering in their protocol when the consumer's agent was created with `throwOnError: true`. When a failed run's `run.wait()` rejects, the ACP handler picks the stop reason from the rejected error's own canonical code (`metadata.code`, else `code`), and the handoff dispatcher replies with `(Handoff target <id> returned status=error: <message>)` using the error's message. This is close to what a resolved error run produces, but not identical: when the run's detail code came from another writer (`agent_loop_failed`, for instance), the error's own code and message are used instead. Any rejection from a run whose status is not `"error"`, such as an abort or an output-processor failure on a finished run, propagates unchanged.
