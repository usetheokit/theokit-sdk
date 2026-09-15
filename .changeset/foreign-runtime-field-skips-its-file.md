---
"@theokit/sdk": patch
---

A subagent written for another runtime no longer stops the whole directory from loading. One
`.claude/agents/*.md` carrying `memory:`, `permissionMode:`, `maxTurns:` or any other field in
`KNOWN_CLAUDE_CODE_FIELDS` threw out of `loadSubagents`, so every sibling agent failed with it and
the turn produced no answer at all — measured in a live session where the offending agent was not
even used by the task. Such a file is now skipped with a diagnostic, the way a file with no
frontmatter already was. A misspelling of one of our own fields (`sandboxx`) is still fatal, so a
typo cannot return as a silent gate.
