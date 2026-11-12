# Published TheoKit packages follow one API stability policy

- Status: Accepted
- Date: 2026-11-12
- Decided by: human/paulo, on 2026-11-12, as proposed
- Applies to: every publishable package in `usetheokit/theokit-sdk` and `usetheokit/theokit`
  (`@theokit/sdk`, `sdk-*`, `acp`, `cli`, `memory-*`, `theokit`, `@theokit/agents`,
  `agents-pty`, `http`, `presenter`, `tauri`, `create-theokit`)

## Context

A consumer of TheoKit cannot tell which exports will still be there next month. The numbers below
were measured on 2026-11-12 from `npm view <pkg> time`, counting the first stable release of each
new major since 2026-05-12:

| Package | Latest | Releases in 6 months | New majors in 6 months |
| --- | --- | --- | --- |
| `@theokit/agents` | 16.5.0 | 179 | 16 (1.0.0 to 4.0.0 all on 2026-07-24) |
| `@theokit/sdk` | 5.17.0 | 213 | 5 (first release was 1.5.0) |
| `@theokit/acp`, `@theokit/cli` | 4.0.2 | 9 each | 4 each |
| `@theokit/memory-*` (three packages) | 3.0.4 | 7 each | 3 each |
| `create-theokit` | 3.0.34 | 125 | 3 |
| `@theokit/http` | 2.4.0 | 19 | 2 |
| `theokit` | 0.80.0 | 172 | 0, but 75 distinct `0.Y` lines |
| `@theokit/sdk-tools` | 0.31.0 | 47 | 0, but 31 distinct `0.Y` lines |

Under semver a `0.Y` bump may break, so `theokit` and `sdk-tools` carry the same churn under a
different number. The `theokit` README says so in its Status section: "the surface still moves
between minor versions".

Breaking changes ship without a deprecation release first. `packages/agents/CHANGELOG.md` mentions a
deprecation 4 times across 16 majors. The 15.0.0 entry is typical: `CheckpointOptions` lost four
fields and two types in one release, with no earlier release marking them deprecated. Changesets
added since 2026-05-12 declare `major` 19 times in theokit and 5 times in theokit-sdk.

The surface is large and its edges are blurred. Counting the names each `exports` entry resolves
through the TypeScript checker gives 921 for `@theokit/sdk@5.15.3`, 1184 for
`@theokit/agents@16.5.0` and 1267 for `theokit@0.80.0`. Some of those names exist only for this
repository's own tests:

- `theokit/server` exports seven `_reset*` helpers (`_resetMiddlewareCacheForTests`,
  `_resetRouteScanCacheForTests`, `_resetKeyCacheForTests`, `_resetWarnOnceForTests`,
  `_resetUninvocableWarningsForTests`, `_resetCacheEngine`, `_resetEnvCache`), and four narrower
  `theokit/server/*` subpaths export some of them again.
- `@theokit/sdk/workflow` exports `__resetSnapshotStoresForTests`.
- `@theokit/sdk-memory` exports `resetMigrationStateForTests` from its root.

`@theokit/sdk` also publishes four `./internal/*` subpaths and `@theokit/sdk-handoff` publishes
`./internal/tool-injector`. `packages/sdk/src/internal/README.md` already records what the SDK four
are for: `persistence` and `security` are raw channels behind a stable facade (`./persistence`,
`./security`), and `memory-adapters` and `memory-store` are shared-kernel channels for
`@theokit/sdk-memory` that deliberately have no facade. `./internal/persistence` is already marked
`@deprecated` in favour of `./persistence`. Outside the SDK repository, the only importers are two
theoclaw tests (`apps/theoclaw/tests/instance-apply.test.ts` and `instance-resolve.test.ts`).

Several gates already read the emitted declarations, and none of them compares a release with the
one before it:

- theokit-sdk, run in CI by `pnpm quality`: `tools/check-public-surface.mjs` (every `@public` name is
  reachable from some entry), `tools/check-dts-export-parity.mjs` (every source-barrel name reaches
  the `.d.ts`), `tools/check-dts-exports.mjs` (the `.d.ts` and the `.js` agree), and
  `tests/lint/internal-subpaths-are-declared.test.ts` (a new `./internal/*` subpath needs a written
  kind). `tools/lib/published-entries.mjs` maps every `exports` entry to its declaration file.
- theokit, run by the unit suite in CI: `packages/agents/tests/unit/subpath-surface.test.ts`
  (a committed name snapshot, `__snapshots__/subpath-surface.json`, for the four infra
  subpaths only), `dts-export-parity.test.ts` and `every-public-type-crosses-the-barrel.test.ts`.
  `scripts/check-changeset-coverage.mjs` already reads changeset frontmatter in CI and refuses a
  range that changes a package's source without naming it.

So the integrity of each release is checked, and its compatibility with the previous release is
not. A stable symbol can be deleted in a PR that every gate passes.

The JSDoc tags survive into the published declarations: the `@theokit/sdk@5.15.3` tarball's `.d.ts`
files carry `@public` 929 times and `@deprecated` 18 times. The SDK also sets `stripInternal: true`
in `tsconfig.base.json`, so `@internal` already means "erase this declaration from the `.d.ts`".

## How three peers handle it

- Vercel AI SDK ([versioning page](https://ai-sdk.dev/docs/migration-guides/versioning)): APIs
  without a prefix are stable, and the project "only introduce[s] breaking changes in major
  releases". Experimental APIs carry an `experimental_` prefix and "can change in any releases".
  Deprecated APIs "will be removed in future major releases". There is no minimum period.
- OpenAI Agents SDK for Python ([release process](https://openai.github.io/openai-agents-python/release/)):
  the package stays at `0.Y.Z`. `Y` increases "for breaking changes to any public interfaces that
  are not marked as beta", and `Z` covers fixes, features, private interfaces and "updates to beta
  features". Each changelog entry states whether the minor breaks anything.
- Mastra: no written stability policy turned up. The
  [1.0 announcement](https://mastra.ai/blog/announcing-mastra-1) says the APIs "were ready to be
  locked and shipped as 1.0", and later 1.x releases mark fields `@deprecated` before removing them
  (for example `ChannelAdapterConfig.cards` in `@mastra/core` 1.37.0, per its release notes).

All three keep stable and experimental apart and remove only in a major. None of them publishes a
minimum deprecation period, and none of them enforces the policy with a surface diff in CI.

## Decision

### Three tiers

| Tier | Promise | How an export declares it |
| --- | --- | --- |
| stable | Breaks only in a major, and only after a deprecation release (below) | Default. An export with no tier tag is stable. `@public` stays allowed and means the same. |
| experimental | May change or go away in any minor. Every change still needs a changeset that says what changed. | `@experimental` (TSDoc) on the declaration's own docblock |
| internal | No promise at all | Not reachable from any `exports` entry, except under a `./internal/*` subpath |

The tier is declared by a JSDoc tag, not by a subpath and not by a name prefix:

1. Promoting an experimental API to stable does not change its import path or its name, so
   promotion is never a breaking change for the people who adopted it early. An `/experimental`
   subpath or an `experimental_` prefix forces a rename at promotion, which is the churn this policy
   exists to remove.
2. The tag reaches the `.d.ts`, which is what the gate below reads, and an editor shows it on hover.
3. The SDK already marks 622 declarations `@public`, so a tag fits the convention in place.

The cost is that a tag is invisible at the import site, so a consumer can use an experimental API
without noticing. Each package README lists its experimental exports, and the gate keeps that list
honest.

Defaulting to stable is deliberate. A forgotten tag then errs toward protecting the consumer, and
the first tagging pass in each package is where the maintainers move what is still in flux to
`@experimental`.

`@internal` keeps its compiler meaning (erase from the `.d.ts`) and is not a tier tag. A symbol
that must stay reachable for a sibling package but has no promise lives under `./internal/*`.

### Deprecation window

A removal, rename or incompatible change to a stable export needs, in this order:

1. A deprecation release: a minor that adds `@deprecated` to the export with the replacement named
   in the tag, a `Deprecated` changelog entry, and a one-time runtime warning where the code path
   can emit one without side effects on output.
2. A window of **at least 90 days and at least 2 further minor releases of that package**,
   whichever ends later.
3. The major that removes it.

Paulo confirmed both numbers on 2026-11-12. The reasoning: at the current cadence (`@theokit/agents` released 179 times in 6 months, roughly
one a day) a count of releases alone ends in days, so the window has to be measured in time. 90
days lets a team that upgrades monthly see the warning in three upgrades before it becomes an
error. 30 days would cover one such upgrade. 180 days would hold the beta-stage packages to a pace
the project has not shown it wants. The minimum of two minors stops a deprecation and its removal
from landing back to back if releases pause.

When the old and new form cannot coexist (a narrowed type, a changed default), the deprecation
release announces the change in its `Deprecated` entry and adds the new form as an opt-in. If no
opt-in is possible, the announcement alone starts the window.

A security fix may break a stable export without the window. Its changeset declares `major` and
says why the window was skipped.

Packages still at `0.Y.Z` follow the same rule with the minor standing in for the major: a stable
export is removed only in a `0.Y` bump, after the same window. This matches the OpenAI Agents SDK
reading of `0.Y` and keeps the release numbers of `theokit` and `sdk-tools` meaningful.

### Internal subpaths and test-only exports

- `./internal/*` subpaths are the internal tier. They stay published while a sibling package needs
  them, are excluded from the gate, and every package README that ships one states that it has no
  compatibility promise. `tests/lint/internal-subpaths-are-declared.test.ts` already requires a
  written kind for each new one, and that rule extends to `@theokit/sdk-handoff`.
- A satellite that imports an `./internal/*` subpath pins the SDK floor it needs, as
  `tests/peer-range-floors.test.ts` already does for `@theokit/sdk-memory`.
- `@theokit/sdk/internal/persistence` is removed in the next SDK major. It is already deprecated and
  `./persistence` replaces it.
- Test-only helpers (`_reset*`, `*ForTests`) leave every published entry. This repository's own
  tests import them from the source module instead. Removing them from `theokit/server`,
  `@theokit/sdk/workflow` and `@theokit/sdk-memory` is a breaking change by the letter of this
  policy, so it ships as a major (`0.Y` bump for `theokit` and `sdk-memory`) without the deprecation
  window. No consumer has a supported use for them, and keeping them for 90 days would publish the
  same names for no one.
- `@theokit/agents/testing` is not test-only in that sense: it is a utility subpath for consumers'
  own tests and gets a tier like any other entry.

### CI gate

Each repository gets a public-surface diff that runs in CI after the build and fails the PR when:

1. a stable export disappears from an entry, is renamed, or moves from stable to experimental, and
   no changeset in the PR declares `major` for that package (`minor` for a `0.Y` package);
2. a stable export's emitted declaration text changes, and the change is anything other than adding
   a new optional property to an interface or object type, with the same changeset requirement;
3. a stable export is removed less than 90 days after its `@deprecated` tag first appeared in the
   baseline;
4. the committed baseline differs from the freshly generated one. A PR that changes the surface
   therefore shows the change in its diff, where a reviewer reads it.

The baseline is one committed file per package that lists, per `exports` entry, each name, its tier,
its normalized declaration text, and the date the gate first saw it `@deprecated`. Names under
`./internal/*` are not recorded.

The gate builds on what exists rather than adding a tool: in theokit-sdk on
`tools/lib/published-entries.mjs` and the compiler-as-oracle approach of
`tools/check-public-surface.mjs`, and in theokit on the snapshot pattern of
`packages/agents/tests/unit/subpath-surface.test.ts` and the changeset reader in
`scripts/check-changeset-coverage.mjs`.

## Alternatives rejected

- **Microsoft API Extractor with its `.api.md` report.** It produces the reviewed report this policy
  wants and understands the TSDoc release tags. It was set aside for now because both repositories
  already resolve every entry through the compiler in their own gates, and API Extractor would be a
  second, separately configured model of the same 36 SDK entries. Its multi-entry support has not
  been measured here, and no spike to measure it is planned. If the in-repo gate turns out costly to
  keep, this is the alternative to reopen.
- **An `/experimental` subpath per package.** Rejected for the promotion cost described above, and
  because it doubles the entry count of packages that already have 26 (`@theokit/agents`) and 36
  (`@theokit/sdk`) entries.
- **The `experimental_` name prefix (Vercel).** It is visible at the call site, which is its real
  advantage, but promotion renames the symbol, which is a breaking change for every early adopter.
- **A policy without a gate.** ADR 0007 in theokit already deprecated two `@theokit/http` subpaths
  instead of deleting them, so the practice exists, but nothing enforced it on the 16 majors of
  `@theokit/agents`.
- **Deleting `./internal/*` outright.** `@theokit/sdk-memory` imports `memory-store` ten times and
  `memory-adapters` once, and the shared kernel exists to stop the two copies drifting apart (theokit#160,
  #430). Removing the channel would bring the duplication back.

## Consequences

- Breaking changes batch up: a removal waits at least 90 days, so the deprecations that mature
  together ship in one major instead of one major per change.
- The first tagging pass is a real cost. Every package needs a review of its exports to decide what
  is experimental, and until that pass ends every export counts as stable.
- Removing the test-only helpers costs `theokit`, `@theokit/sdk` and `@theokit/sdk-memory` one
  breaking release each, ideally combined with the next one they make anyway.
- The gate checks declaration text, so a stable type that gains an optional property passes while a
  formatting-only change in the emitted text fails until the baseline is regenerated. The second
  case is noise the reviewer accepts in exchange for a gate that never misses a change.

## Deferred

Whether `theokit` and the `0.Y` SDK satellites should move to 1.0 once their exports are tagged is
not decided here. Paulo will decide it later, in its own record. Until then those packages follow
the `0.Y` rule above.
