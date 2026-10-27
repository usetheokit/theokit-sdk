---
"@theokit/sdk": patch
---

An OpenAI-compatible provider's HTTP 400 now ends the run with a `ConfigurationError` whose message says what the provider rejected. OpenRouter answers a model id it does not know with `nosuchvendor/nosuch-model-xyz is not a valid model ID`, and until now the message was only `openrouter API error: invalid_request (HTTP 400)`, so neither the error nor `result.error.message` named the model or the parameter. The 400 message now ends with the provider's `error.message`, for example `openrouter API error: invalid_request (HTTP 400): Expected max_tokens to be at least 1`. The class, the error `code` and `isRetryable` do not change.

The provider's text goes through the same secret redaction as `metadata.raw` and is cut at 512 characters, ending with `…` when it is longer. The missing-model 404 message, which already carried the provider's text, gets the same redaction and cap. Every other status (401, 403, 408, 429, 5xx and the rest) keeps its message as it was. Code that compared a 400 message by equality will now see a longer string.
