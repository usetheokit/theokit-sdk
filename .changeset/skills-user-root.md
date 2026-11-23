---
"@theokit/sdk": major
---

`@theokit/sdk/skills`: add `skills.userDir`, a user-level skills root read after project and plugin roots and before `bundledDirs`. Export `resolveSkillRoots` (the ordered roots `explainSkills` reports), `parseSkillFrontmatter` and `binaryOnPath`.

Breaking for type consumers: `SkillsExplanation.roots[].kind` gains `"user"`, so an exhaustive switch over it must handle the new kind.
