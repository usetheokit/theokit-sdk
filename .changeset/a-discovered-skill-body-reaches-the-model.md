---
"@theokit/sdk": patch
---

`skill_read` can read a skill discovered on disk. It could not, which made the entire on-disk skills surface decorative.

`SkillReadTool.create` took `ReadonlyArray<InlineSkill>` — the shape that carries `instructions` on
the object. A disk-discovered skill is a `Skill`, whose own declaration says "the skill BODY is never
included", so it did not fit through the door at all. The result: a `SKILL.md` was listed by name and
description in the `<skills>` block, the model asked to read it, and got back a heading and an empty
body — measured, the handler returned `"# Skill: deploy\n\n"`.

The instructions under the frontmatter are the skill. Every other skill defect in this backlog is a
field inside a file whose body never showed up.

`create` now accepts `ReadableSkill` — a skill that carries its body, or one that knows where its
body is — and the handler resolves the difference. Passing inline skills is unchanged.

**Read when the model asks, not at construction.** Eager reading would turn "this agent knows about
twelve skills" into twelve file reads at startup, to answer a question the model usually does not
ask. The handler's contract already allowed `Promise<string>`, so laziness cost one `await` and no
new API.

The handler is deliberately NOT `async`. Marking the whole function async turns the input schema's
synchronous throw into a rejected promise, and this module's contract is that malformed input "fails
at the trust boundary via the schema". Measured while making this change: two trust-boundary tests
went from throwing to returning `undefined`. Only the body read is asynchronous — parse and the
not-found answer stay exactly as synchronous as they were.

A disk skill's `references/` directory is now read too, for the same reason inline skills already
render theirs in full: the two shapes describe the same thing, and one of them arriving empty was the
asymmetry. A document that cannot be read is skipped rather than failing the whole read — a skill
should not become unreadable because something beside it is.

`${CLAUDE_SKILL_DIR}` resolves to the skill's own directory — the reason skills are directories
rather than single files. A skill ships scripts and reference documents beside its `SKILL.md`, and
without the placeholder the body had no expressible path to them: the skill does not know where it
was installed, and neither does its author at the time of writing.

Only for a skill read from disk. An inline skill has no directory, so the text is left exactly as
written — an honest limit rather than a guess. Leaving it says "this does not apply here"; inventing
a path would hand the model a command that fails somewhere plausible.
