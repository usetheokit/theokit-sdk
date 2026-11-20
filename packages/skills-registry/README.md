# @theokit/skills-registry

Skill package format, version resolution and a verified, atomic install of `SKILL.md` folders.

## Package format

A package is JSON, at most 1 MiB (`MAX_PACKAGE_BYTES`):

```json
{ "name": "demo", "version": "1.0.1", "description": "…",
  "files": [{ "path": "SKILL.md", "contentBase64": "…" }] }
```

- `name`: lowercase letters, digits and single hyphens, at most 64 characters.
- `version`: SemVer 2.0.0 (prerelease and build metadata allowed). One parser serves the whole package; numeric components are compared as digit strings, so large values are exact.
- `files`: at least one, no repeated path. A path may not be empty, absolute, contain `\`, NUL, a drive letter, or an empty, `.` or `..` segment, and may not be `.origin.json`.
- `SKILL.md` must exist. Its whole frontmatter is read: a repeated field, a malformed line, or a `name` that is not one plain or quoted scalar equal to the package name is refused (`invalid_skill_md`).

## Registry contract

- `GET <registry>/v1/skills/<name>` → `{ "versions": [{ "version": "1.0.0", "sha256": "<hex of the package bytes>" }] }`
- `GET <registry>/v1/skills/<name>/<version>/package` → the package JSON.

The registry URL must be `https:`, or `http:` for `localhost`, `127.0.0.1` and `[::1]` (`insecure_url`). Redirects are not followed.

## Use

```ts
import { downloadSkill, installSkill } from "@theokit/skills-registry";

const pkg = await downloadSkill("https://registry.example", "demo"); // or "demo@1.1.0-beta.1"
await installSkill("/home/me/.skills", pkg, { registry: "https://registry.example" });
```

`downloadSkill` without a version picks the highest stable release, and a prerelease only when there is no stable one. It enforces the byte cap while reading and a timeout (`timeoutMs`, default 30 s), checks the listed sha256, and writes nothing.

`installSkill` revalidates the package, writes to a temporary sibling of `<skillsDir>/<name>`, adds `.origin.json` (`registry`, `name`, `version`, `sha256`), then swaps it in with a rename. If the swap fails the previous version is restored. Readers may see the folder missing for the instant between the two renames.

## Errors

`SkillsRegistryError.code`: `invalid_name`, `invalid_version`, `not_found`, `unreachable`, `too_large`, `digest_mismatch`, `unsafe_path`, `invalid_skill_md`, `invalid_package`, `insecure_url`, `install_failed`.
