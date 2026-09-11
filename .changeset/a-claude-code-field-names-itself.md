---
"@theokit/sdk": patch
---

A subagent frontmatter field that belongs to Claude Code now says so, and names its siblings.

**The failure itself is unchanged, deliberately.** A file that declares frontmatter and gets it
wrong is a broken agent and still fails the load — the reason is recorded a few lines above, where
skipping was added only for files with _no_ frontmatter: "a file that HAS frontmatter and gets it
wrong is a broken agent and still fails loudly, which is what keeps a typo'd `sandbox` from
returning as a silent gate through this door." Isolating the failure per file would hand that risk
back.

What changes is the diagnosis. A user migrating a `.claude/agents/` tree learned one key per round
trip: fix `memory`, meet `permissionMode`, fix that, meet `maxTurns` — with nothing saying the set
was finite or that the tree was simply written for another runtime. The error now distinguishes
"another runtime's field" from "never heard of this", and lists the other eleven that will behave
the same way.

That distinction already exists here for `INERT_CLAUDE_CODE_FIELDS`, described as "the difference
between 'we know this one and it does nothing' and 'we have never heard of this' — two facts a bare
allow-everything would collapse into one." This adds a third fact beside them and changes only the
message, never the verdict.
