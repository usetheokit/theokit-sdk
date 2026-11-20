---
"@theokit/sdk": minor
---

Add `AgentOptions.modelFallback`: a turn that fails before any assistant output reruns on the next listed model on the same agent, with one user message in the transcript. Failed attempts are listed on `RunResult.modelFallbackAttempts`; when every model fails the run ends `error` with `ModelFallbackExhaustedError` (#1023).
