---
"@theokit/sdk": minor
---

Add `AgentOptions.modelFallback` and `ModelFallbackExhaustedError`: when a turn fails with a provider or network error before any assistant text or tool call was streamed, the SDK reruns it on the next fallback model on the same agent (#1023). `RunResult.modelAttempts` lists every model tried.
