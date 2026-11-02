---
'@theokit/sdk': minor
---

A run can now stop resending old tool results to the model. Every tool result used to be resent on
every later LLM call of a run, so a run whose tools print a lot grew its request by that output on
every round. The new per-send option `pruneToolResults: { olderThanRounds: n }` replaces the
content of each tool result older than `n` tool rounds with a short stub in the request the agent
loop sends. The stub keeps the result's `toolUseId` and `isError`. The transcript the run keeps,
persists and resumes from stays whole, so the stub applies only to the request. The option is off by default, and
without it the request is unchanged. `olderThanRounds` must be an integer of at least 1. Any other
value fails the send with `ConfigurationError` code `invalid_prune_tool_results` before any provider
call. The option type is exported as `PruneToolResultsOptions`.
Pruning trades request size against prefix-cache reuse: each new round stubs one more previously
sent result, so on providers that cache message prefixes the cached prefix ends earlier. That cost
was not measured.
