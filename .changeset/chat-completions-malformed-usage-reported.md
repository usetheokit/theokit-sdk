---
"@theokit/sdk": patch
---

A chat-completions stream whose usage carries a negative, non-finite or non-numeric `prompt_tokens`, `cached_tokens` or cache-write count no longer reports that count as 0. The field is left out of the turn's usage and the SDK writes `provider reported an unusable inputTokens (…)` (or `cacheReadTokens`, `cacheWriteTokens`) to the diagnostics sink, as it already did for every other malformed count, so a proxy sending a broken usage object is no longer billed and budgeted as a turn with no input. `normalizeUsage` still reads such a count as 0. (B-412)
