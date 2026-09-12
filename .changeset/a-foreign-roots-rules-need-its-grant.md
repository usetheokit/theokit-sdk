---
"@theokit/sdk": minor
---

A foreign root's rules now need the grant that already gates everything else in that directory.

`FileContextManager.initialize()` gated project-level context on
`settingSourcesIncludeProject || settings.manager === "file"` and consulted no foreign-dialect
grant. `compatSources` appeared nowhere under `src/internal/runtime/context/`. So a consumer who
enabled project scope for its OWN `.theokit/` and deliberately never declared `claude-code` still
received a cloned repository's `.claude/rules/*.md` in its system prompt — while the same
directory's hooks, skills, subagents and plugins were correctly withheld. Four surfaces failing
closed, and a fifth nobody had wired to the gate (#652).

The root cause was not a missing `if`. `CompatSurface` was `"hooks" | "plugins" | "skills" |
"subagents"`: there was no member for instructions, so no grant could govern them and the gate had
nothing to consult. `"context"` is now a surface like the others, paired to its runtime list by the
existing compile-time exhaustiveness guard, and each discovery spec names the dialect whose grant
gates it. Adding a dialect is adding a row.

**This is a behaviour change, and the note is here rather than buried.** A consumer who declared no
compat source stops receiving `.claude/rules/*.md`. It is released as a minor because it aligns one
surface with the four that already fail closed, because the loss is announced at runtime by the
undeclared-source warning (which now names rules alongside the others), and because there is an
explicit way back: `compatSources: ["claude-code"]`, or `{ kind: "claude-code", import: ["context"] }`
for that surface alone. A reader who weighs the removal differently should say so before the cut.

**Release ordering, measured rather than assumed.** This gate must ship AFTER its consumers have a
name to grant. `@theokit/agents@13.4.0` — the version `TheoCode` resolves today — declares
`CompatSurface = 'commands' | 'hooks' | 'plugins' | 'skills' | 'subagents'`, with no `context`, and
`TheoCode` passes exactly that list as its narrowed `import`. Cutting this release first would take
`.claude/rules` from it silently, with no word it could write to ask for them back. The order is:
`@theokit/agents` publishes the vocabulary, consumers declare `context`, then this.

**What is deliberately NOT gated**, because an undocumented gap reads as an oversight:
`AGENTS.md`, `GEMINI.md` and `.cursor/rules/*.mdc` are every bit as foreign, and `adaptersFor`
registers no adapter for any of them — so `compatSources` has no spelling that admits one, and
gating them would strand three formats with no way to restore them. `CLAUDE.md` is left ungated by
judgement rather than by limit: the grant gates the foreign ROOT, that file sits at the repository
root beside the other three, and projects with no `.claude/` at all use it as a generic
agent-instructions file. Whether a repo-root instruction file should require an opt-in is a product
decision affecting every consumer, not a bug fix.
