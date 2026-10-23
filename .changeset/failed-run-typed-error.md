---
"@theokit/sdk": minor
"@theokit/acp": patch
"@theokit/sdk-handoff": patch
---

`@theokit/acp` and `@theokit/sdk-handoff` keep answering in their protocol when the consumer's agent was created with `throwOnError: true`. When a failed run's `run.wait()` rejects, the ACP handler picks the stop reason from the rejected error's own canonical code (`metadata.code`, else `code`), and the handoff dispatcher replies with `(Handoff target <id> returned status=error: <message>)` using the error's message. This is close to what a resolved error run produces, but not identical: when the run's detail code came from another writer (`agent_loop_failed`, for instance), the error's own code and message are used instead. Any rejection from a run whose status is not `"error"`, such as an abort or an output-processor failure on a finished run, propagates unchanged.

`@theokit/sdk`: a failed run's `result.error.cause` is now always a `TheokitAgentError`, and `RunErrorDetail.cause` is typed that way. A failure with no SDK error behind it (a budget denial, the iteration limit, a hook, a cloud run failure, a non-SDK exception) carries an `UnknownAgentError` with the run's message and code, holding the original value at its own `cause`. `result.error.message` and `result.error.code` are unchanged.

`AgentOptions.throwOnError` now reaches the run itself, as its doc comment promised. `run.wait()` rejects with `result.error.cause`, and so do `agent.generate`, `agent.fork` and `agent.runToCompletion`. `agent.runUntil` and `agent.streamToCompletion` throw it from their iterator, and `Agent.batch` returns it as the failed item's `error`. A workflow `agentStep`, a cron task and an `Eval` row keep recording the failure, now with the typed error's class name, code or message. `Agent.prompt` still rejects with `AgentRunError`, whose `cause` is the typed error. Cancelled and finished runs still resolve, the `postRun` hook still fires on a failed run, and a run nobody awaits raises no unhandled rejection.
