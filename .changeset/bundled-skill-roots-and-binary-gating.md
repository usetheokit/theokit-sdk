---
'@theokit/sdk': minor
---

An application can ship skills in its own package and gate them on a binary. `skills.bundledDirs`
lists extra skill roots read after the project roots and plugin bundles, so a workspace skill of the
same name always wins. A skill declaring `requires-bins: git, rg` in its frontmatter is not offered
to the model while one of those executables is absent from PATH; `skills.get(name)` still resolves
it. `SkillReadTool.create` also accepts a function returning the skills, evaluated on every call, so
a skill discovered after the agent was created is readable by the model.
