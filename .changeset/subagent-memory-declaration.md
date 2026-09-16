---
"@theokit/sdk": minor
---

A subagent's `memory:` frontmatter is carried on `AgentDefinition.memory` instead of failing the
file. The SDK does not resolve the root, read `MEMORY.md` or touch the prompt: which of three roots
a note lives under is a decision about who can see it, `@theokit/agents` owns that decision with
`resolveAgentMemory`, and a second copy of the rule here is how the two drift into disagreeing about
privacy. The value passes through unjudged so a scope a newer `@theokit/agents` has learned is not
rejected by a list in this package. `permissionMode`, `maxTurns` and the rest of
`KNOWN_CLAUDE_CODE_FIELDS` still skip their file.
