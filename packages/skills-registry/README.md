# @theokit/skills-registry

The package format for distributing `SKILL.md` folders, one semver rule, a verified `downloadSkill`, and an atomic `installSkill`.

```ts
import { downloadSkill, installSkill } from "@theokit/skills-registry";

const pkg = await downloadSkill("https://registry.example.com", "demo"); // or "demo@1.1.0-beta.1"
const { dir } = await installSkill("./.theokit/skills", pkg, { registry: "https://registry.example.com" });
```

## Package format

A package is JSON, at most 1 MiB (`MAX_PACKAGE_BYTES`):

```json
{ "name": "demo", "version": "1.0.0", "description": "…", "files": [{ "path": "SKILL.md", "contentBase64": "…" }] }
```

- `name`: lowercase letters, digits and `-`, up to 64 characters.
- `version`: SemVer 2.0 (prerelease and build metadata allowed). `compareSkillVersions` is the only comparator.
- `files`: at least one, no repeats, and a `SKILL.md` whose frontmatter `name:` equals the package name.
- A path is refused (`unsafe_path`) if it is empty, has a backslash or NUL, is absolute, starts with a drive letter, or has an empty, `.` or `..` segment. `.origin.json` is reserved.

## Registry API assumed

`GET <registry>/v1/skills/<name>` returns `{ "versions": [{ "version", "sha256" }] }`, and
`GET <registry>/v1/skills/<name>/<version>/package` returns the package. The registry URL must be `https:`
(`http:` only for `localhost`, `127.0.0.1`, `[::1]`); redirects are not followed.

## Version choice

`"demo"` picks the highest **release**; a prerelease is chosen only when pinned (`demo@1.1.0-beta.1`) or when the
skill has no release. Downloads stop with `too_large` as soon as the cap is crossed; the sha256 from the listing is
checked (`digest_mismatch`).

## Install

`installSkill(skillsDir, pkg, { registry })` re-validates the package, writes it into a unique temporary sibling,
adds `.origin.json` (`registry`, `name`, `version`, `sha256`), and renames it to `<skillsDir>/<name>`. An existing
version is moved aside first and restored if the swap fails (`install_failed`).

## Errors

`SkillsRegistryError.code`: `invalid_name`, `invalid_version`, `invalid_package`, `not_found`, `unreachable`,
`too_large`, `digest_mismatch`, `unsafe_path`, `invalid_skill_md`, `insecure_url`, `install_failed`.
