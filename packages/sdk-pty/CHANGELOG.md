# @theokit/sdk-pty

## 0.4.0

### Minor Changes

- [#1275](https://github.com/usetheokit/theokit-sdk/pull/1275) [`bae4bde`](https://github.com/usetheokit/theokit-sdk/commit/bae4bde53fa6a24184fca17804d41ffc7f3cdd8e) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - Add `createConfinedPtyBackend` (root-forced cwd, sandbox wrap, scrubbed environment) and `probeConfinement`, which proves on this host that the confinement works and returns the reason when it does not ([#1040](https://github.com/usetheokit/theokit-sdk/issues/1040)).

## 0.3.6

## 0.3.6-next.1

### Patch Changes

- Updated dependencies [667bd3d]
- Updated dependencies [edfa59c]
- Updated dependencies [4415f83]
- Updated dependencies [9181434]
- Updated dependencies [edfa59c]
- Updated dependencies [edfa59c]
- Updated dependencies [4be7411]
- Updated dependencies [24fb692]
- Updated dependencies [edfa59c]
- Updated dependencies [912e3b9]
- Updated dependencies [374dd5f]
- Updated dependencies [16a996f]
- Updated dependencies [667bd3d]
- Updated dependencies [63617cd]
- Updated dependencies [edfa59c]
- Updated dependencies [edfa59c]
- Updated dependencies [926cb81]
- Updated dependencies [7f91326]
- Updated dependencies [edfa59c]
- Updated dependencies [243bd2c]
- Updated dependencies [edfa59c]
- Updated dependencies [ba6549f]
- Updated dependencies [edfa59c]
- Updated dependencies [374dd5f]
- Updated dependencies [374dd5f]
- Updated dependencies [21be5cb]
- Updated dependencies [edfa59c]
- Updated dependencies [5d174f2]
- Updated dependencies [0c4df84]
- Updated dependencies [618cd02]
- Updated dependencies [edfa59c]
- Updated dependencies [d1182ae]
- Updated dependencies [31fea8f]
- Updated dependencies [691d8e6]
- Updated dependencies [1499923]
- Updated dependencies [0ceeddc]
- Updated dependencies [f64ab2b]
- Updated dependencies [558dd30]
- Updated dependencies [94722e8]
- Updated dependencies [6aeeadb]
- Updated dependencies [7f2bce4]
- Updated dependencies [edfa59c]
- Updated dependencies [266ffc8]
- Updated dependencies [e0a1ab9]
- Updated dependencies [edfa59c]
  - @theokit/sdk@5.0.0-next.1

## 0.3.6-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 0.3.5

### Patch Changes

- e8b8930: Raises the `@theokit/sdk` peer floor from `>=4.4.1` to `>=4.54.0`.

  This range **passed** the CI leg that builds each package against its own floor, and that is what
  makes it worth recording. `sdk-pty`'s build does not typecheck the SDK's declarations, so a broken
  `.d.ts` never reaches its compiler. A consumer's does.

  Measured across the 4.x line with `skipLibCheck: false` and `@types/node` + `zod` installed —
  the environment a real consumer has:

  | version    | errors inside the SDK's own `.d.ts` |
  | ---------- | ----------------------------------- |
  | 4.4.1      | 6                                   |
  | 4.19.3     | 7                                   |
  | 4.53.1     | 7                                   |
  | **4.54.0** | **0**                               |

  4.54.0 is the first version a TypeScript consumer can compile against at all (#335 / #345 / #348).
  The old floor was true about this repository's build and false about the consumers the field exists
  to inform — and where those disagree, the consumer's answer is the one a peer range is making a
  claim about.

## 0.3.4

### Patch Changes

- e3f2a82: Public-API documentation reviewed file by file, and corrected wherever it disagreed
  with the code. The docblocks ship in the `.d.ts`, so these read as behaviour changes
  in an editor even though no behaviour changed.

  The corrections that change what a caller would do:

  - **`sdk-cache` documented its own premise backwards.** The header example labelled a
    semantic hit as if it avoided the provider call. `asPlugin()` returns the cached
    answer as `recalledContext`, which the agent loop injects as a `<memory-context>`
    block _before_ the prompt — the request still goes to the provider. The two modes
    are now labelled separately, with a table saying which one short-circuits and which
    one seeds.
  - **`sdk-handoff`'s five error classes said "throw".** Under the plugin wiring the
    handler never throws; every failure becomes a tool result `{"ok":false,…}` handed
    back to the model. Each class now says where it is actually observable. The header
    also told readers to `import { Handoff } from "@theokit/sdk"`, from which it was
    extracted.
  - **`sdk-budget`'s `charge()` claimed idempotency across concurrent calls.** The mutex
    serialises, it does not deduplicate: two identical calls record twice. Related, and
    newly documented: with `maxUsd` set, a model missing from the pricing table denies
    every request rather than passing it — and the table matches by exact string, so
    `"openai/gpt-4o"` does not match `"gpt-4o"`.
  - **The three `memory-*` adapters advertised an env-var fallback they do not read**,
    and their peer dependencies are required rather than optional. Their behavioural
    differences are now stated where they break the "interchangeable adapter"
    assumption — honcho ignores `k` and always throws on `delete`; mem0 recalls across
    sessions by design; supermemory ignores `sessionId` entirely.
  - **`sdk-memory`'s `truncated` flag was documented as its own inverse**, and its
    dreaming sweep claimed a mutex it never takes against the writer it names.
  - **`sdk-tools`** corrected `run_vitest`'s unreachable `no_vitest` code, `truncation`'s
    replacement-character claim, and two return shapes missing a live error code.
  - **`acp`/`cli`** corrected sixteen statements including a named error class that is
    not the one raised, a handler documented as calling `fork()` that refuses
    unconditionally, handlers described as pure that mint ids and mutate a store, a
    config loader credited to Zod in a package that does not import it, and a `--force`
    scaffold described as atomic that deletes the destination before the rename.

  Undocumented public symbols were documented across every package, with each claim
  checked against the implementation rather than inferred from the name.

- e368fc1: Every published declaration file now compiles without `skipLibCheck` (#345). The
  DTS rollup emitted symbols as a re-export from a chunk while omitting them from
  that chunk's `import`, and dropped type-only imports from external packages —
  leaving 51 unresolved references across ten of the twelve packages. Nothing broke
  at runtime, and `tsc` stayed green for anyone with `skipLibCheck` on, but a
  consumer running type-aware lint saw every type reached through one degrade to
  `error`.

  The declarations are repaired at build time from the compiler's own diagnostics.
  No source or API change.

- 1ac974f: **`@theokit/sdk-pty` declares its licence.** Every published version up to now shipped with no `license` field in the manifest. npm reads the field, not the directory, so the tarball was all-rights-reserved to whoever installed it — the terms were sitting in the `LICENSE` file it already shipped, saying nothing. The field now says `Apache-2.0`, which is what that file has always been and what all eleven sibling packages declare.

  **Four packages now ship the licence they declare.** `@theokit/cli`, `@theokit/memory-honcho`, `@theokit/memory-mem0` and `@theokit/memory-supermemory` declared `Apache-2.0` and listed `LICENSE` in `files`, and no such file existed. npm omits a declared-but-absent path in silence, so every published tarball asserted the licence while carrying none of its terms — and §4(a) requires a copy to travel with the distribution. The file is there now, byte-identical to the one the other packages ship.

  **Six packages complete the rest of their published metadata.** Each field is here for what its absence costs a consumer:

  - `homepage` and `bugs` — the npm page renders both; without them someone who hits a defect has no route back to the project.
  - `engines.node` — npm warns on an unsupported runtime only when the range is declared. `@theokit/sdk-pty` declared none, so a Node 18 install failed later and somewhere unrelated.
  - `sideEffects` — a bundler keeps every module of a package that stays silent. Declared only after checking: a clean scan of each built ESM entry found zero top-level statements, the residual hits being closing tokens of declarations. `@theokit/sdk` keeps its path-array form, which is the honest shape for a package whose agent entry registers on import.
  - `publishConfig.access` — a scoped package defaults to `restricted`. Three declared none and reached npm public only because the release flow supplied the flag; the manifest states it now instead of depending on how it is invoked.
  - `@theokit/sdk-pty` also ships its `CHANGELOG.md`, which existed on disk and was absent from `files`.

  The gate that should have caught any of this covered three packages out of twelve, by way of a hand-written list. It now derives the list from `packages/`, asserts the whole contract, and fails when the sweep discovers nothing rather than passing by having nothing to check.

- e699569: **The repository moved to the official `usetheokit` organization.** Every `repository`, `bugs` and `homepage` field now points there, along with the README, `CONTRIBUTING.md`, `SECURITY.md` and the issue templates. Existing clones and any URL already published keep working — GitHub redirects a transferred repository permanently — so this is a correctness fix for the metadata npm renders, not a break.

  **The Apache-2.0 text every package ships was replaced with the official one.** The copy distributed until now had paragraph 4(d) truncated: it read "except as required for describing the origin of the Work and reproducing the content of the NOTICE file", dropping "reasonable and customary use" from the licensed clause. §4(d) governs what a redistributor must do with attribution notices, and the omission narrowed it.

  That matters more than a typo would. The manifests declare the SPDX identifier `Apache-2.0`, which is an assertion that the terms are _the_ Apache-2.0 terms — a licence scanner resolves the identifier and never reads the file. A consumer's compliance review, which does read the file, would find a body that no longer matches the identifier and has no name of its own. Every `LICENSE` in this repository is now byte-identical to the canonical text, with the appendix filled in.

  Nothing else about the terms changed: the licence is the same licence it has always been meant to be, and no package changes what it grants.

- c7385d2: Test runs no longer claim every core on the host.

  None of the package configs capped `maxWorkers`, so vitest's default applied: `os.availableParallelism()`,
  one fork per core, each booting a full test environment. The repo's `test` script is
  `turbo run test --filter='./packages/*'`, so that default is paid once per package _concurrently_ —
  nproc forks times turbo's concurrency, on nproc cores. Measured on a 12-thread machine during an
  unrelated investigation, two vitest pools alone were enough to reach load average 33.89 with the
  desktop unusable; a full fan-out is several times that.

  `@theokit/sdk` is the interesting case. B-104 recorded on 2026-08-19 that the `poolOptions.forks.*`
  block was 100% dead in Vitest 4, deleted it, and noted that `fileParallelism: false` was forcing
  `maxWorkers` to 1 unconditionally, so a fork-count knob could not act. B-059 then flipped
  `fileParallelism` to `true` on 2026-08-20, which made the knob able to act again — and nothing
  reintroduced one, so the package silently went back to the uncapped default. That comment has been
  corrected along with the config; it claimed no knob existed, which is no longer true.

  The cap leaves 4 cores free (`Math.max(2, cpus().length - 4)`), scaling with the runner rather than
  hard-coding one machine's core count. It costs no wall-clock: measured in `theokit-ui`, the full
  suite ran 73.96s at 4 workers against 74.36s at 12, so the parallelism above the cap was already
  noise. Verified as resolved config rather than as file contents — `createVitest` reports
  `maxWorkers: 8` on a 12-thread host, which is the formula, not the default.

  This changes no published behaviour; it is test tooling only. Refs usetheokit/theokit-ui#51.

## 0.3.3

### Patch Changes

- a3ae640: Declare `repository` so these packages can publish with provenance.

  npm cross-checks a manifest's `repository.url` against the repository recorded in the signed
  provenance statement, and an empty value cannot match — the PUT is refused with E422 after the
  statement has been signed and written to the public transparency log. Six of the twelve publishable
  packages carried an empty field; it went unnoticed because nothing needed it until provenance was
  enabled, and because each package publishes independently, so the release run went red while the
  package everyone was watching succeeded.

  `directory` is set alongside the URL, so the registry links to each package rather than to the
  repository root.

## 0.3.2

### Patch Changes

- 8790f70: Refuse a `workspace:` range before it can reach npm.

  Five of this repo's twelve publishable packages declare internal dependencies as `workspace:^`, which
  is correct on disk and becomes an unrecoverable defect if the publish goes out through a tool that
  does not rewrite it: `pnpm` resolves the protocol while packing, `npm` ships the manifest verbatim.
  A version published that way fails to install for everyone and cannot be corrected — only
  deprecated.

  Every publishable package now runs the guard in `prepublishOnly`, so it fires whichever way the
  publish is invoked, and `pnpm release` runs it once across the repo before `changeset publish`.

  Note for anyone reading a published manifest: the `prepublishOnly` entry points at a path inside
  this repository. It never runs for a consumer — the hook only fires when the package itself is
  published — and guarding the entry point that a hand-run `npm publish` actually uses was worth the
  cosmetic wart of shipping the line.
