---
'@theokit/sdk': patch
---

On the OpenAI Responses API, `usage.inputTokens` is now the uncached part of the prompt, as it
already was on the Anthropic and Chat Completions clients. The client used to pass `input_tokens`
through as it came, and that total already includes the cache read and cache write buckets. A turn
that hit the prompt cache therefore counted its cached tokens twice: once in `inputTokens` and once
in `cacheReadTokens` / `cacheWriteTokens`.

Things a caller can observe on a cached turn through a provider whose `apiMode` is
`"responses_api"`, the built-in `openai-chatgpt` (Codex) provider among them:

- `RunResult.usage.inputTokens`, the `inputTokens` attribute of the `llm.call` span and the
  `theokit_llm_tokens` histogram are lower by the cached tokens.
- The run's computed cost no longer bills the cached tokens a second time at the full input
  price.
- A `BudgetTracker` input event carries the prompt once, so a `maxTokens` ceiling no longer trips
  early. A USD tracker still prices the cached tokens of that event at the input rate, so it trips
  less early than before but still early. For a prompt of 11 tokens with 3 read from the cache and
  5 written to it, the event reports 11, where it reported 19 before.
