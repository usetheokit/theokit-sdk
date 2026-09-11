---
"@theokit/sdk": patch
---

Skill frontmatter's two authorization fields are read instead of discarded, and one of them is now enforced.

`buildFrontmatter` kept exactly `name`, `description`, `category` and `dependencies`. `user-invocable`
and `disable-model-invocation` survived the YAML parser and were dropped one function later, so a
template could declare a restriction the runtime could not honour — and the default is disclose-all.
`create-theokit` ships seven skills carrying `user-invocable: false`, and all seven were inert.

**`disable-model-invocation: true` is now enforced.** A skill reaches the model through exactly one
place — the system-prompt context — so the declaration is a filter there. This is the capability the
format names when it says you do not want the model deciding to deploy because the code looks ready:
a side-effecting skill a human may run and the model may not propose. It is a **disclosure** rule,
not an execution rule — `skills.get(name)` still resolves a hidden skill, because a caller naming one
has already made the decision the field exists to keep away from the model. Widening it to execution
would break the case the field is for.

**`user-invocable: false` is carried, deliberately not enforced here.** This SDK has no user-facing
invocation surface for skills; there is no slash command. Reading `agent.skills.list()` as "the user"
would be a guess — a host may call it to build a picker or to introspect, and those want opposite
answers. The declaration now travels to the host that knows, instead of being thrown away.

A value the dialect cannot read is refused rather than ignored. This dialect coerces only the
literals `true` and `false`, so `disable-model-invocation: yes` — a valid YAML boolean — arrived as
the string `"yes"`, compared unequal to `true`, and the skill was disclosed. The author wrote a
restriction and got the default. A restriction that fails open is worse than an absent one, because
the author stops looking; the skill is now reported as invalid and excluded, naming the value.
