# Changelog — @theokit/sdk-memory

## 0.6.0

### Minor Changes

- [#724](https://github.com/usetheokit/theokit-sdk/pull/724) [`bc2f665`](https://github.com/usetheokit/theokit-sdk/commit/bc2f665d4c5e03dda26858004ac60bd1f7d3f3bb) Thanks [@usetheodev](https://github.com/usetheodev)! - Memory can now be given a fact ceiling. Once the store is full, a new fact is refused with a
  typed error. Before this, nothing stopped the store growing, and the one cap that did exist, 500
  facts per dreaming sweep, left the rest out of clustering while the result still said
  `status: "ok"`.
  
  Set `memory.maxFacts` on an agent to declare a ceiling. A new fact at or over it is refused with a
  `ConfigurationError` whose code is `memory_ceiling_reached`, and nothing is written. The message
  gives the directory, how many facts it holds, the ceiling and what to consolidate. Recording a fact
  that is already stored counts as a second observation, not a new fact, so it is still admitted. A
  value that is not a positive integer is refused with `invalid_memory_ceiling` by `Agent.create`
  and `Agent.resume`, before the agent exists, and again by the writer before anything touches
  disk. A prompt-driven memory write that hits the ceiling reports it on one diagnostic line and
  stores nothing. With no ceiling declared, nothing changes and no extra read happens.
  
  The ceiling holds across processes. Every SDK process that writes one memory directory with a
  ceiling takes a lock (`<directory>.lock`, beside the directory) around the count and the write, so
  two processes one fact below the ceiling no longer both get in. The lock needs the optional
  `proper-lockfile` peer. Without it the ceiling holds within one process only, and the SDK says so
  once on its diagnostics channel. A writer that declares no ceiling, such as the Claude Code CLI,
  takes no lock and can still add facts past it.
  
  A resumed agent keeps its ceiling and its `memory.directory`. The directory is now saved with the
  agent, and a `memory` object passed to `Agent.resume` replaces only the fields it sets (a field
  set to `undefined` keeps its persisted value). Before
  this, `Agent.resume(id, { memory: { enabled: true } })` came back with no ceiling, and any resumed
  agent wrote to the default store instead of the directory it was created with.
  
  `createInMemoryMarkdownProvider({ maxFacts })` in `@theokit/sdk-memory` applies the same ceiling
  to the adapter's `write` and to the `memory_remember` tool. Each handle counts its own facts.
  
  `DreamingSweepResult` gains `factsLeftOut`, the number of deduplicated facts past the 500-fact
  cap that a sweep did not cluster. It is reported on both dispatch paths, the `@theokit/sdk-memory`
  peer and the SDK's own fallback. It is 0 on a skipped sweep and absent on a failed one. It is also
  absent when an older `@theokit/sdk-memory` runs the sweep, because that version cannot count it,
  so read absence as unknown, not as 0. `ClusterResult`, which `@theokit/sdk-memory` exports, now
  requires `factsLeftOut` too. Code that builds its own `ClusterResult`, such as a mock of
  `remPhase`, has to add it.
  
  `@theokit/sdk-memory` now needs `@theokit/sdk` `^5.10.0`, the first release that exports the
  ceiling helpers it imports.

## 0.5.3

### Patch Changes

- [#570](https://github.com/usetheokit/theokit-sdk/pull/570) [`64ff1f8`](https://github.com/usetheokit/theokit-sdk/commit/64ff1f8e072725dbc4d4dbbb5f82e6f1bca6141e) Thanks [@usetheodev](https://github.com/usetheodev)! - The memory index moves with a relocated store — the note this package's consumers never got ([#562](https://github.com/usetheokit/theokit-sdk/issues/562))
  
  This is documentation, not behaviour. The change shipped in `@theokit/sdk@5.0.0` and is already
  live for anyone on that version; what did not ship is any way for a `@theokit/sdk-memory` consumer
  to find out. Its `0.5.2` section is empty — no dependency lines, no prose — so the release that
  carried a privacy-relevant change reached its most directly affected audience with zero signal.
  
  **Why this package's readers are the audience.** `@theokit/sdk-memory` owns the markdown store and
  re-exports `memoryIndexRoot` (`src/internal/store/markdown-store.ts`). Someone reading this
  CHANGELOG to decide whether a version is safe to take is exactly the person the note was written
  for.
  
  ## What changed in the behaviour
  
  `memory.directory` now moves the search index with the store, except into the Claude Code CLI's own
  directory ([#554](https://github.com/usetheokit/theokit-sdk/issues/554)).
  
  The index is not a pointer. `chunks.text` holds the fact TEXT — FTS5/BM25 needs it to search — and
  `files.path` holds the store's absolute path. **A copy of the index is a copy of the memory,
  readable with `strings`.**
  
  Leaving it at `<cwd>/.theokit/memory/.index/` while the facts moved meant an operator who pointed
  `directory` at one personal store had that store's contents written into *every repository the
  agent ran in*, untracked and un-ignored. Recall worked throughout, so nothing looked wrong; what
  was wrong was where the data landed.
  
  ```
  before   /tmp/my-store/fact.md              facts move
           /any-project/.theokit/memory/.index/memory.sqlite    ← and the content follows here
  
  after    /tmp/my-store/fact.md
           /tmp/my-store/.index/memory.sqlite                   ← one store, one index
  ```
  
  The Claude Code CLI's directory is unchanged, on its own argument: that CLI has no index format, so
  a binary there is an artefact the partner does not understand inside a directory it owns
  (`docs/memory-decisions.md` § 1). The fix narrows the behaviour to match that argument rather than
  reversing the decision.
  
  ## What this does not do
  
  **The `0.5.2` section is not edited.** A published entry is a record of what shipped, and rewriting
  it would make the record disagree with the tarball on npm. The note arrives in the next version
  instead, which is later than it should have been and is the honest way to be late.
  
  If you are on `0.5.2` the behaviour above is already what you have, through the `@theokit/sdk` you
  resolve — this entry only tells you so.

## 0.5.2

## 0.5.2-next.1

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

## 0.5.2-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 0.5.1

### Patch Changes

- 300d8f9: The declared `@theokit/sdk` floor rises to `>=4.63.0`, which is what this package has needed since
  it stopped carrying copies.

  `resolveMemoryRoot`, `sessionsDir`, `writeSessionSummary`, `discoverSessionFiles`,
  `discoverWikiFiles`, `persistActiveMemoryTranscript`, `collectMarkdownFiles`, `defaultIndexPath`,
  `lanceStoragePath`, `readAllSqliteFacts` and the diary module all arrived in 4.63.0. Against
  `>=4.60.0` the install resolves and the imports do not exist — `dep-check`'s floor leg has been
  saying so out loud, correctly, since the de-duplication landed.

  It could not be corrected in that release: a package cannot declare a floor that is not published
  yet, and 4.63.0 was the version that release created. `onlyUpdatePeerDependentsWhenOutOfRange`
  meant changesets would not raise it either, because `>=4.60.0` still admits 4.63.0 and so nothing
  looked out of range. The bump had to wait for the version to exist, which it now does.

## 0.5.0

### Minor Changes

- 6410e27: The satellite follows the SDK's single memory-root resolver (#463).

  `Memory.runDreamingSweep` routes through this package whenever it is installed, so a satellite that
  kept deriving `<cwd>/.theokit/memory` on its own would have reverted `memory.directory` to the
  default for exactly the consumers who installed it — the failure this package's own store shim was
  written to end, one release later.

  Its path helpers now take a resolved `MemoryRoot` like the SDK's: `sessionsDir`, `wikiDir`,
  `diaryPath`, `defaultIndexPath`, `lanceStoragePath`, `collectMarkdownFiles`, `discoverSessionFiles`,
  `discoverWikiFiles`, `persistActiveMemoryTranscript` and `createMemoryGetTool` (`cwd` → `root`).
  `SessionSummaryInput.cwd` becomes `memoryRoot`. `memoryDir` and `memoryWriteDir` are gone from the
  re-export; `resolveMemoryRoot`, `projectMemoryDir`, `memoryReadRoots`, `asMemoryRoot` and
  `MemoryRoot` replace them. `migrateSqliteToLance` and the Lance index accept the root.

  Two more copies of the layout literal were found the same way the SDK's were — by the type error,
  not by a search: `index-db.ts` and `lance-index.ts` each spelled `.theokit/memory` out again
  instead of calling the shared helper.

## 0.4.0

### Minor Changes

- 4aa19d1: Installing this package no longer makes the memory store unreadable.

  `Memory.runDreamingSweep` in `@theokit/sdk` replaces its own store with this package's whenever this
  package is installed. This package carried a full copy, and the copy stayed on the layout that
  predates the file-per-memory format — so it could not read anything the SDK had written. The sweep
  reported `factsBefore: 0`, a number indistinguishable from an empty store (#430). Nothing threw.

  The store is now imported from `@theokit/sdk/internal/memory-store` rather than copied, which is why
  the `@theokit/sdk` peer floor rises to `>=4.60.0`: that is the version the sub-path first ships in,
  and importing a path an admitted version does not export is a load-time crash, not a type error.

  The exported signatures are supersets of what this package exposed before — the added parameters are
  optional — so existing calls are unaffected. What changes is that `appendFactToMarkdown` now writes a
  file per memory with `MEMORY.md` as its index, instead of a bullet under `## Facts`. Bullets written
  by earlier versions are still read.

  The promise this broke — _"the fallback is not a degraded mode"_ — now has a test. It had none, which
  is why the two copies drifted for two format changes without anything going red.

## 0.3.3

### Patch Changes

- 1a4bbcf: The declared `@theokit/sdk` peer ranges stop promising versions the packages do not compile against.

  All three declared `>=4.0.0`. `4.0.1` is the lowest published version that range admits — what a
  consumer pinning conservatively, or resolving under an older transitive constraint, lands on. npm
  resolves the combination with no `ERESOLVE` and no peer warning, and the build then fails on
  `TS2552: Cannot find name` and `TS2305: has no exported member`.

  The floors were measured by bisecting the 116 stable 4.x releases with a real build as the oracle.
  Each one has its immediately preceding version failing, so these are exact versions rather than
  intervals:

  | package                | floor      | evidence                        |
  | ---------------------- | ---------- | ------------------------------- |
  | `@theokit/sdk-budget`  | `>=4.54.0` | `4.53.1` fails, `4.54.0` passes |
  | `@theokit/sdk-handoff` | `>=4.54.0` | `4.53.1` fails, `4.54.0` passes |
  | `@theokit/sdk-memory`  | `>=4.53.1` | `4.53.0` fails, `4.53.1` passes |

  `sdk-memory` sits one release below the other two: this is not one shared migration, it is three
  packages that each drifted past their own declared floor.

  The oracle deletes every `dist/` before building. Without that the build reads a sibling's output
  compiled against a different version, which is how a package "passes" against an SDK missing its
  symbols — the failure mode that made the earlier measurement disagree with CI
  (usetheokit/theokit-sdk#423).

- 4b5e468: Raises the `@theokit/sdk` peer floor from `>=4.53.1` to `>=4.54.0`.

  Not because this package outgrew 4.53.1 — because **4.53.1's own published declarations do not
  compile**. Building against it fails inside the SDK's `.d.ts`, not in any code here:

  ```
  @theokit/sdk/dist/index.d.ts(350,24):  error TS2552: Cannot find name 'AgentBuilderDeps'
  @theokit/sdk/dist/index.d.ts(3004,15): error TS2304: Cannot find name 'DECLARED'
  ```

  #345 (`e368fc18`) bound the re-exported names the rollup had left unimported, and first shipped in
  4.54.0. A floor that names 4.53.1 therefore promises a version nobody can build against.

  Worth separating from the sibling fixes in this release: those floors were wrong because the code
  had outgrown them. This one is wrong because the version it names is broken — a distinct reason to
  audit a floor, now recorded beside it.

## 0.3.2

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

## 0.3.1

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

## 0.3.0

### Minor Changes

- a4a9920: `@theokit/sdk-memory` now uses the SDK's embedding runtime instead of its own copy (theokit#160).

  The two packages each carried a full copy of `createOpenAiCompatibleRuntime`, and the satellite's
  catalog replaces the SDK's at runtime when installed — so the copy that ran was not the copy most
  people read. That duplication is what produced the two-month adapter gap fixed in theokit#128, and
  every fix since had to be applied to both files by hand.

  There is now one implementation, imported from `@theokit/sdk/internal/memory-adapters` — a
  semver-exempt sub-path in the same family as `internal/persistence` and `internal/security`, which
  exist for exactly this reason.

  **Behaviour change for `@theokit/sdk-memory` consumers:** embedding batches now run with bounded
  parallelism instead of serially, and the embedding cache is process-wide instead of per-adapter.
  Both are what the SDK already did; the satellite had silently missed both improvements.

- 0308f9f: `@theokit/sdk-memory` now serves every embedding provider the SDK advertises (theokit#128).

  `azure-openai`, `cohere`, `jina` and `gemini` landed in the SDK core catalog in June 2026 and the
  satellite never picked them up. That was not cosmetic drift: when `@theokit/sdk-memory` is
  installed, its catalog _replaces_ core's in the routing path, while `Theokit.inspect.embeddingAdapters()`
  kept listing all ten — so asking for one of the four got an "unknown provider" error from a provider
  the SDK itself had just advertised. A cross-package test now fails the build if core ever advertises
  a provider the peer cannot serve.

  Also fixes the Azure OpenAI endpoint in both packages. Azure addresses the deployment in the URL
  path (`/openai/deployments/{deployment}/embeddings`), and the placeholder was never substituted —
  every Azure embedding request went to a URL containing the literal text `{model}` and could only 404. Providers with a static path are unaffected.

- 0bd082f: Three advertised embedding providers now actually work (theokit#159).

  `azure-openai`, `cohere` and `gemini` were in the catalog and rejected on every call. The shared
  runtime spoke exactly one wire — `Authorization: Bearer`, a `{ model, input }` body, a
  `{ data: [{ embedding }] }` response — and none of the three speak it:

  - **Azure** authenticates an API key with the `api-key` header (`Bearer` carries an Entra ID token,
    not the key from `AZURE_OPENAI_API_KEY`), and the deployment is already in the URL path, so
    `model` does not belong in the body.
  - **Cohere**'s `/v2/embed` names the payload `texts`, requires `input_type`, and answers
    `{ embeddings: { float } }`.
  - **Gemini**'s OpenAI-compatible surface is at `/v1beta/openai/embeddings`, not `/v1/embeddings`.

  The runtime gained three optional per-provider hooks — auth headers, request body, response reader —
  whose defaults are exactly the previous behaviour, so the seven providers that were already correct
  are untouched. Each divergence is asserted by a test that records the real request.

  Advertising a provider that cannot work is worse than not advertising it; that is what this closes.

## 0.2.2

### Patch Changes

- 453ad2d: SE43 — system-design audit fixes (public-surface changes).

  - **`@theokit/sdk` (minor):** the shared persistence kernel is now reachable from the sanctioned public `@theokit/sdk/persistence` barrel — `withCwdMutex`, `sanitizeFts5Query`, and `PersistenceSchema` are added (joining `replaceFileAtomic` / `openSqliteResilient` / `atomicWriteText` / `atomicWriteJson`). The `@theokit/sdk/internal/persistence` export is now **deprecated**: it re-exports its full surface unchanged for one release (back-compat) and is scheduled for removal in a future major. No breaking change; existing imports keep working.
  - **Satellites (patch):** `sdk-tools` / `sdk-memory` / `sdk-cache` / `sdk-handoff` / `sdk-budget` tightened their `@theokit/sdk` peer-range floor from `>=1.7.0` to `>=4.0.0`, matching the v4-only surfaces they import (prevents a non-workspace install resolving an incompatible old sdk).

## 0.2.1

### Patch Changes

- 826bca0: Security (#56) — close two residual cross-tenant active-recall cache leaks found by adversarial review.

  - `@theokit/sdk-memory` (publishable) called `cache.get`/`cache.set` with no tenant context, so two callers with the same query text but different identity shared a cached recall — a cross-tenant leak for every consumer of the package. The cache read/write are now keyed by the `{namespace, userId, scope}` tenant tuple (the primitive already supported it).
  - In `@theokit/sdk` the production caller hardcoded `namespace: "default"` and dropped `memoryContext.tenantId`, so two tenants sharing a `userId` collided on one cache entry. The caller now threads `memoryContext.tenantId` into the tenant partition (`namespace`). `sessionId` is intentionally not a key dimension — recall is cross-session by design.

## 0.2.0

### Minor Changes

- 809418a: M4-3 — typed categorized memory store (plan `m4-categorized-memory`).

  - `createCategorizedMemory({ root, categories })` — a typed, category-partitioned markdown memory store. `add(category, text)` validates `category` against the closed `categories` taxonomy (fail-loud `ConfigurationError(code: "unknown_category")` before any I/O), redacts secrets, and appends a bullet to `<root>/<category>.md` (frontmatter header + `## Facts`) atomically and serialized per category file (`withCwdMutex` — no lost update under concurrent adds). `list(category?)` returns `CategorizedFact[]` for one category or all; never throws (a missing file → no facts). Construction validates the taxonomy is non-empty, unique, sanitizable, and sanitized-unique.
  - `MemoryFact` gains an optional `category?: string` (backward-compatible — flat-store facts omit it).

  Composes the shipped `safePathJoin`/`sanitizeIdentifier` (`@theokit/sdk/path-safety`), `redactSecrets`, and `replaceFileAtomic`/`withCwdMutex` (`@theokit/sdk/internal/persistence`). Zero new dependencies — explicitly NOT adding `zod` (the closed `categories` set is the runtime-checked schema).

## [Unreleased]

### Changed

- Reorganized the flat 43-file `src/internal/` god folder into 5 sub-concern folders (arch-review M5): `embedding/` (10), `index/` (12), `active-memory/` (5), `dreaming/` (3), `store/` (7); 6 cross-cutting files (`adapter-catalog`, `adapter-http-error`, `circuit-breaker`, `memory-scope`, `memory-types`, `tools`) remain at the `internal/` root. Pure file moves + import-path updates — no behavior/API change (the package barrel `index.ts` re-exports identically); all 324 tests GREEN, `madge --circular` clean.

### Security (drift sync — iter 112/114/115, 2026-06-09)

Three security/perf hardenings shipped in `@theokit/sdk`'s
`internal/memory/` copies AFTER Stage 3 source-move completed
(iter 44-75) were silently absent from `@theokit/sdk-memory`'s
hybrid copies. Per ADR 0002 Stage 4 byte-equivalence invariant,
they have now been synced. Consumers routing through
`@theokit/sdk-memory` get the hardened behavior. The drift detector
(iter 93) caught each gap and flipped to PASS after the sync.

- **T4.9 — cross-tenant cache-key collision (iter 112)** —
  `active-memory-cache.ts`'s `cacheKey` now accepts an optional
  `TenantContext` (`namespace`/`userId`/`scope`) and NUL-separates
  every key part. Pre-sync, two users sharing a process with the
  same query could receive each other's cached result (DR4 finding
  #9 — CRITICAL cross-tenant data leak).

- **T4.6 — dreaming O(N²) sweep cap (iter 114)** —
  `dreaming-phases.ts`'s `remPhase` accepts an optional
  `maxFactsPerSweep` (default 500) and deterministically
  subsamples when input exceeds the cap. Pre-sync, a 5000-fact
  sweep ran 12.5M cosine-similarity comparisons (unacceptable).

- **T5.2 — Lance SQL escape hardening (iter 115)** —
  `lance-index.ts`'s `escapeSqlValue` now rejects NUL bytes,
  C0 control chars, and DEL via `ConfigurationError({code:
'sql_injection_blocked'})`, and escapes backslashes (`\` →
  `\\`) in addition to single quotes. Pre-sync, only `'` → `''`
  was applied — `\'` could escape the closing quote on engines
  that interpret backslash-escapes.

### Added (Stage 3 source-move COMPLETE — iter 44-75, 2026-06-08 → 2026-06-09)

38/38 source files from sdk-core's `internal/memory/*` now have
canonical hybrid copies in this package. sdk-core retains its copies
for v1.x back-compat; consumers installing this package get the
canonical surface that sdk-core's Stage 4 routing delegates to.

**Closed clusters:**

- Dreaming (iter 54+59+60): `dreaming-phases.ts`, `dreaming-diary.ts`,
  `dreaming-run.ts` + `active-memory-types.ts` (iter 48)
- Sessions (iter 61+62): `session-summary-writer.ts`, `session-loader.ts`
- Storage (iter 53+55-58+62): `markdown-store.ts`, `chunk-markdown.ts`,
  `reader.ts`, `transcript-store.ts`, `wiki-loader.ts`
- Index (iter 47+49-50+65-72): `index-manager-contract.ts`,
  `index-schema.ts`, `memory-index.ts`, `index-db.ts`,
  `sqlite-vec-loader.ts`, `vec-index.ts`, `lance-index.ts`,
  `lance-memory-adapter.ts`, `index-manager-dispatch.ts`,
  `index-manager.ts`
- Migration (iter 63+71): `migration.ts`, `migrate-sqlite-to-lance.ts`
- Adapters (iter 45+46+73+74): `embedding-adapter.ts`,
  `embedding-cache.ts`, `openai-compatible.ts` + inlined
  `adapter-http-error.ts` + 6 provider adapters
  (openai/mistral/openrouter/voyage/deepinfra/ollama) +
  `adapter-catalog.ts`
- Core (iter 44+51+52+64+75): `circuit-breaker.ts`,
  `active-memory-cache.ts`, `memory-types.ts`, `tools.ts`,
  `active-memory.ts`

**Optional peers** (sdk-memory dynamically loads when present):

- `better-sqlite3` (iter 65)
- `sqlite-vec` (iter 66)
- `@lancedb/lancedb` (iter 68)

**287 GREEN tests** across 38 files document every move's behavior;
**zero unexpected drift** between sdk-core and sdk-memory copies
(verified by the Stage 3 drift detector, iter 93).

### Added (Phase 1 Stage 3 prep — iter 33-35, 2026-06-08)

- `createInMemoryMarkdownProvider.recordSessionSummary` ships REAL
  filesystem-backed impl (was no-op). Writes
  `${cwd}/.theokit/memory/sessions/${sanitizeRunId(runId)}.md` via
  `replaceFileAtomic` imported from `@theokit/sdk/internal/persistence`
  (ADR-008 sub-path resolution). Mirrors sdk-core's legacy
  `writeSessionSummary` semantics — YAML frontmatter + User/Assistant
  sections, 2000-char truncation, runId sanitization.
- `runActivePass()` now reads previously-written session summaries
  from disk + substring-matches against the user message — closes
  the "write but never read" gap. In-process Map facts AND disk-recall
  hits both contribute to `systemPromptAdditions`. Capped at 5 hits
  per pass.
- NEW LLM-facing tool: `memory_search(query)` — surfaced in
  `buildTools` alongside `memory_remember`. The LLM can explicitly
  query the disk sessions corpus when the user references past
  conversations. Returns JSON `{ok, count, results: [{id, snippet}]}`.

### Changed (Phase 1 physical Stage 1 — iter 19, 2026-06-08)

- `createInMemoryMarkdownProvider` now implements the new optional
  `sync(handle)` port method (no-op for the in-process impl — facts
  are written synchronously to the Map at handler-call time; nothing
  to re-index post-run). Future LanceDB-backed impl will fire
  `IndexManager.sync()` here. Back-compat preserved: existing impls
  that omit `sync` are still valid per the optional-method spec.

## [0.1.0] — 2026-06-08

### Added

- Initial release. Consumes the `MemoryProvider` port from `@theokit/sdk@>=1.7.0`
  (SDK 2.0 Phase 1 / T1.6).
- `createInMemoryMarkdownProvider()` — first concrete impl. In-process
  fact store; LLM-facing `memory_remember` tool; `runActivePass()` emits
  `systemPromptAdditions` for recalled facts; full lifecycle compliance.

### Notes

- LanceDB / embeddings / circuit-breaker / dreaming-sweep deferred to future
  versions. This release ships the package foundation + a working impl so
  the SDK 2.0 cohort can publish (Phase 7).
- `peerDependency`: `@theokit/sdk >= 1.7.0` (where the port was shipped).
