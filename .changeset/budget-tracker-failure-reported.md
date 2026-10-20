---
'@theokit/sdk': patch
---

A `BudgetTracker` whose `track()` throws no longer loses the turn's other event, and the failure is
reported. The agent loop used to call `track()` for the input and the output events inside one `try`
with an empty `catch`. An input event that threw skipped the output event, and nothing said so, so a
`maxTokens` or USD ceiling counted less than the run spent. Each event now gets its own call, and a
throw is reported through the diagnostics sink, or on stderr when no sink is installed. The message
names the event type, the model id, the token count and the error. The turn still finishes.
