---
'@theokit/sdk': patch
---

Correction to the 5.12.0 note on malformed chat-completions `prompt_tokens`: the dropped count is left out of the per-call `LlmFinish` and no input budget event is emitted for it, and the SDK writes `provider reported an unusable inputTokens (…)` to the diagnostics sink. `RunResult.usage` and `usage.requests[]` still read that count as `inputTokens: 0`, because `TokenUsage.inputTokens` is a required number; only a consumer with a diagnostics sink can tell a dropped count from a real zero. The diagnostic prints `NaN` in place of the value the provider sent.
