---
"@theokit/sdk": minor
---

Testing: `@theokit/sdk/testing` adds `startScriptedModelServer`, a fake model server that answers ordered steps (text, tool calls, HTTP errors with `retry-after`) on the openai or ollama wire, and `assertConsumed()` throws `UnexpectedModelCallError` or `UnconsumedModelStepsError` when the loop makes more or fewer model calls than scripted.
