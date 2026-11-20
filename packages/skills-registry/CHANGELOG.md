# @theokit/skills-registry

## 0.1.0

### Minor Changes

- [#1337](https://github.com/usetheokit/theokit-sdk/pull/1337) [`66fb5f1`](https://github.com/usetheokit/theokit-sdk/commit/66fb5f1f5c9a50f6a18714e311d522cb0a7ced73) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - Add `searchSkills`, `buildSkillPackage` and `publishSkill` with the same HTTPS-or-loopback guard, timeout and byte cap as install, and the error codes `unauthorized`, `version_exists` and `rejected` ([#1055](https://github.com/usetheokit/theokit-sdk/issues/1055)).

- [#1340](https://github.com/usetheokit/theokit-sdk/pull/1340) [`3ae5204`](https://github.com/usetheokit/theokit-sdk/commit/3ae520416f93db09a9b19a87d4c06497df5ab7c9) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - Add `createSkillsRegistryHandler`, a fetch-style reference registry server that stores immutable versions on disk with the digest saved at publish time ([#1056](https://github.com/usetheokit/theokit-sdk/issues/1056)).

- [#1326](https://github.com/usetheokit/theokit-sdk/pull/1326) [`c20f607`](https://github.com/usetheokit/theokit-sdk/commit/c20f607c1c63c4a6c971d41d32c0707bae57f440) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - New package: skill package format, one SemVer parser, typed `SkillsRegistryError` codes, `downloadSkill` with digest, size and path checks, and an atomic `installSkill` with rollback ([#1054](https://github.com/usetheokit/theokit-sdk/issues/1054)).
