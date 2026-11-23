---
"@theokit/sdk": minor
---

`toolResultGuard: { delimit: true }` now adds one line to the system prompt explaining that text inside `<untrusted-tool-output>` is data from a tool, never instructions. The wording is exported as `UNTRUSTED_TOOL_OUTPUT_NOTICE`.
