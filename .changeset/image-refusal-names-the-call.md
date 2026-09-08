---
"@theokit/sdk": patch
---

The image-in-tool-results refusal names the tool call whose result carried the image (#629)

Before:

```
provider "openai-responses" does not support image content in tool results
```

After:

```
provider "openai-responses" does not support image content in tool results —
the result of tool call call_42 carried an image, and this wire carries tool results as text only
```

Accurate before, and unhelpful. The person who hit it had attached an image and asked a question about it; they never asked for a tool, so a message naming *tool results* pointed at a surface they had not used. Measured downstream (`usetheoai-lab/TheoCode#133`): the turn that failed made two tool calls and the five that succeeded made none — asking for *dimensions and colours* provoked a tool call, asking for *one word* did not, which is why it looked intermittent and was not.

The **id** rather than the tool's name, and stated rather than quietly settled for: `LlmToolResultPart` carries `toolUseId` only — the name lives on the matching `LlmToolCallPart` in an earlier message, and the four sites that construct a tool result do not have it either. The id is the correlation key that exists at the call site, it is what a reader can find in a transcript, and it does not pretend to be a name.

The parameter is optional, so nothing that calls this helper with two arguments changes.
