---
"@theokit/sdk": minor
---

Add `startScriptedModelServer` to `@theokit/sdk/testing`: a fake model server that answers ordered steps (text, tool calls, HTTP errors), with `assertConsumed()` throwing `UnexpectedModelCallError` or `UnconsumedModelStepsError` when the agent loop makes more or fewer model calls than scripted.
