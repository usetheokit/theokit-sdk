---
'@theokit/sdk': minor
---

`@theokit/sdk/mcp-events`: subscribe to events from an MCP server that implements the events profile. `createMcpEventSubscriber` sends `events/subscribe` over Streamable HTTP with a per-subscription HMAC secret, runs a local callback receiver, and passes each event to your callback with its subscription id. A delivery with a wrong `x-mcp-signature` is rejected with 401 and never reaches the callback.
