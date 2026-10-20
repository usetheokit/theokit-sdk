---
'@theokit/sdk': patch
---

`run.cancel()` on a local run now aborts the provider request. Until now it only set the status to `cancelled`: the LLM request kept streaming, `onDelta` kept receiving updates, and the provider billed the whole generation. The run now aborts the request, stops waiting for in-flight tool calls and passes the abort to custom tool handlers through `ctx.signal`, and delivers no update to `onDelta` once it is terminal. A run cancelled while its MCP servers start up runs no turn, and still closes the MCP clients it owns. A cancelled turn reports no `usage` or `cost`: its result resolves when you cancel, before the turn's usage is collected.
