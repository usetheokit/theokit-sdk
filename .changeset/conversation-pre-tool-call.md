---
"@theokit/sdk": minor
---

`pre_tool_call` plugins receive the run's conversation: `AgentOptions.conversation` and `SendOptions.conversation` (send wins) take a `ConversationRef` (`platform`, `channelId`, `sessionKey`), exposed as `PreToolCallContext.conversation` and omitted when none is declared (#1032).
