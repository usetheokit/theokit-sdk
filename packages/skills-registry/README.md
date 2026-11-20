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

## Search and publish

```ts
import { buildSkillPackage, publishSkill, searchSkills } from "@theokit/skills-registry";

const hits = await searchSkills("https://registry.example", "pdf"); // GET /v1/skills?q=pdf
const pkg = await buildSkillPackage("./my-skill");
await publishSkill("https://registry.example", pkg, { token }); // PUT /v1/skills/<name>/<version>
```

- `searchSkills(registryUrl, term, { fetch?, timeoutMs?, maxBytes? })` returns `{ name, description, latest, versions }` entries and drops malformed ones. Defaults: 10 s timeout, 1,000,000-byte response cap.
- `buildSkillPackage(dir)` reads a folder into the package format. Symbolic links and anything but regular files are refused (`unsafe_path`, naming the path), as is a folder over 1 MiB (`too_large`), a missing `SKILL.md`, and frontmatter without `name`, `description` and a SemVer `version`.
- `publishSkill(registryUrl, pkg, { token, fetch?, timeoutMs? })` sends the bearer token with the same URL guard as install: `https:`, or `http:` on loopback, otherwise `insecure_url` before any request. Default timeout 30 s (`unreachable`). 201 resolves; 409 is `version_exists`, 401 `unauthorized`, 400 `rejected` (carrying the server's `error` text). The token never appears in an error message.

## Errors

`SkillsRegistryError.code`: `invalid_name`, `invalid_version`, `not_found`, `unreachable`, `too_large`, `digest_mismatch`, `unsafe_path`, `invalid_skill_md`, `invalid_package`, `insecure_url`, `install_failed`, `unauthorized`, `version_exists`, `rejected`.

## Running a registry

```ts
import { createServer } from "node:http";
import { createSkillsRegistryHandler } from "@theokit/skills-registry";

const handler = createSkillsRegistryHandler({ dir: "/var/lib/skills", token: process.env.PUBLISH_TOKEN! });
// `handler` is `(request: Request) => Promise<Response>`: mount it in any fetch-style server.
```

- Routes: `GET /v1/skills?q=`, `GET /v1/skills/<name>`, `GET /v1/skills/<name>/<version>/package`, `PUT /v1/skills/<name>/<version>`.
- Versions are immutable: a second publish answers 409 and the stored bytes stay. Each version is stored with its sha256, written at publish.
- Publish needs `Authorization: Bearer <token>` (wrong token: 401 with `www-authenticate: Bearer`). A body over `maxPackageBytes` answers 413; an invalid package answers 400. `maxPackageBytes` can only lower the 1 MiB ceiling.
- A handler failure answers 500 and calls `onError(error, { method, path })`; the default writes one stderr line with the token redacted.

**Warning:** the handler binds nowhere; it listens where you mount it, so bind to loopback or put your own access control in front. The token protects publish only: search, listings and package downloads are open to anyone who can reach the handler.
