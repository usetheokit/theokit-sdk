---
'@theokit/sdk': minor
---

Prompt caching now turns on for Anthropic models, and the cache counters they report reach the
turn's usage.

For a model id that starts with `anthropic/` or `claude` (after an optional `openrouter/`,
`vertex/` or `bedrock/` prefix),
the agent loop sends the system prompt as text blocks: the configured prompt first, marked with
`cache_control: { type: "ephemeral" }`, then the `<active-memory>` block when memory adds one. The
Anthropic client sends the blocks as they are, and the OpenRouter client sends them as `content`
parts of the `system` message, with `cache_control` on the cacheable part. Every other provider
still receives one string. Bedrock ids (`anthropic.claude-…`) are not matched,
and their bodies do not change. Vertex Anthropic ids (`vertex/anthropic/claude-…`) are matched
and get the same blocks; no live Vertex response was measured for this change.

Things a caller can observe:

- **Billing.** Anthropic charges cache writes at 1.25 times the input price and cache reads at 0.1
  times. A run with a single turn whose system prompt is above the model's caching minimum pays
  the write premium and never reads the prefix back.
- **Order.** For these models the memory block now comes after the configured prompt instead of
  before it. On a client that joins the blocks into one string, the text is the same and the order
  is reversed.
- **What still misses the cache.** The cached prefix is the whole assembled prompt, so `<memory>`
  facts, resolved skills or context that change between turns change block 1 and miss.
- **Counters.** The Anthropic streaming client reads `cache_read_input_tokens` and
  `cache_creation_input_tokens` from `message_start`, where Anthropic reports them; a value in
  `message_delta` still wins when it is above zero, and a zero there leaves the `message_start`
  value in place. The non-streaming parser shared by the Bedrock and Vertex Anthropic clients now
  returns both counters too.
- **Cost on the chat-completions client.** `prompt_tokens` there already includes the cached
  slice, and the client used to report it whole as `inputTokens` beside `cacheReadTokens`, so the
  estimated cost charged every cached token twice (about 8 times too high on a cached
  OpenRouter Anthropic turn). `inputTokens` is now the uncached portion, as on the Anthropic
  client, and `prompt_tokens_details.cache_write_tokens` is read into `cacheWriteTokens`. A
  native OpenAI chat-completions run with a cache hit reports a lower `inputTokens` and a lower
  cost than before. When a usage object carries both the nested `prompt_tokens_details` counts and the
  Anthropic-style top-level ones, the nested count wins and a top-level count fills a nested
  zero, the rule `normalizeUsage` already applied; the stream client used to let the top-level
  field win.
- **Budget trackers.** A `BudgetTracker`'s `input` event now carries the whole prompt:
  `inputTokens` plus `cacheReadTokens` and `cacheWriteTokens`. On the chat-completions client this
  keeps the count a tracker saw before `inputTokens` became the uncached portion. On the Anthropic
  clients, which always reported the uncached portion, a cached turn now counts its cached tokens
  against `maxTokens`, and `createUsdBudgetTracker` prices them at the input rate, so a cost cap
  trips earlier than the provider's bill would.
- **Input tokens on the Anthropic stream.** `input_tokens` is read from `message_start` too, so a
  stream whose `message_delta` carries only `output_tokens` reports its uncached input instead of
  none. A value above zero in `message_delta` still replaces it; a `null` or a zero there leaves
  the `message_start` count.
- **Malformed Anthropic frames.** A `content_block_start`, `content_block_delta` or
  `message_delta` frame that is not valid JSON now fails the turn with a retryable `NetworkError`
  (`code: "stream_malformed_frame"`) instead of being skipped, which finished the turn with text
  or tool input missing. Any other malformed frame is still skipped and reported on the
  diagnostics channel. The error message and the diagnostic line name the event and the frame's
  length, never its body, which can hold model output or tool input.
