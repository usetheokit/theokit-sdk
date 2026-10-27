# Changelog

## 0.1.6

### Patch Changes

- [#763](https://github.com/usetheokit/theokit-sdk/pull/763) [`473616d`](https://github.com/usetheokit/theokit-sdk/commit/473616d2585f11c9c2878a47e17665111279388a) Thanks [@usetheodev](https://github.com/usetheodev)! - `@theokit/acp` and `@theokit/sdk-handoff` keep answering in their protocol when the consumer's agent was created with `throwOnError: true`. When a failed run's `run.wait()` rejects, the ACP handler picks the stop reason from the rejected error's own canonical code (`metadata.code`, else `code`), and the handoff dispatcher replies with `(Handoff target <id> returned status=error: <message>)` using the error's message. This is close to what a resolved error run produces, but not identical: when the run's detail code came from another writer (`agent_loop_failed`, for instance), the error's own code and message are used instead. Any rejection from a run whose status is not `"error"`, such as an abort or an output-processor failure on a finished run, propagates unchanged.
  
  `@theokit/sdk`: a failed run's `result.error.cause` is now always a `TheokitAgentError`, and `RunErrorDetail.cause` is typed that way. A failure with no SDK error behind it (a budget denial, the iteration limit, a hook, a cloud run failure, a non-SDK exception) carries an `UnknownAgentError` with the run's message and code, holding the original value at its own `cause`. `result.error.message` and `result.error.code` are unchanged.
  
  `AgentOptions.throwOnError` now reaches the run itself, as its doc comment promised. `run.wait()` rejects with `result.error.cause`, and so do `agent.generate`, `agent.fork` and `agent.runToCompletion`. `agent.runUntil` and `agent.streamToCompletion` throw it from their iterator, and `Agent.batch` returns it as the failed item's `error`. A workflow `agentStep`, a cron task and an `Eval` row keep recording the failure, now with the typed error's class name, code or message. `Agent.prompt` still rejects with `AgentRunError`, whose `cause` is the typed error. Cancelled and finished runs still resolve, the `postRun` hook still fires on a failed run, and a run nobody awaits raises no unhandled rejection.

## 0.1.5

## 0.1.5-next.1

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

## 0.1.5-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 0.1.4

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

## 0.1.3

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

- 5742ab2: `Handoff.asPlugin(...).register()` now returns a promise that settles once the transfer tools are
  registered.

  It used to start an unawaited async IIFE and return, so the tools appeared a module-load later —
  whether they existed for the first `send()` depended on timing no caller controlled — and
  `HandoffSelfReferenceError` / `HandoffNameCollisionError` became unhandled rejections that could not
  be caught around `Agent.create`, leaving an agent silently without handoff tools. The plugin
  contract already typed `register` as returning `void | Promise<void>` and the manager already
  awaited it. The import stays lazy.

- 33524a5: A handoff now tells the receiving agent what the user asked.

  Both wirings built the transfer tool through a handler that dispatched with an empty transcript, so
  the receiver was sent the literal string `(Handoff from <sender> — no prior user message in
history.)` and answered from that plus its own system prompt. The handler now forwards the
  supervisor's transcript, which the SDK hands every tool handler, and the dispatcher takes the last
  user turn from it.

  `HandoffOptions.inputFilter` was dead in the same way — invoked, always with nothing to filter, so a
  caller who wired a redactor believed the transcript was being scrubbed. It now receives the real
  transcript, and dropping a message there does keep it from the receiver.

- 9f0362c: `Handoff.create()` refusals now carry an error class and a stable code.

  Both of its guards raised a bare error, so a caller wanting to distinguish "no target given" from
  "the target is not an agent" had only the message text to match on — and message text is not a
  contract. It changes whenever someone improves the wording, and nothing tells the consumer their
  check stopped working.

  Each refusal is now a `ConfigurationError` with its own code. The change is additive rather than
  breaking: the error class extends `Error`, so anything catching `Error` still catches it, and both
  messages are unchanged.

- 1484293: The schema converter that decides what a model is shown now has tests.

  It converts a handoff's input schema into the JSON Schema the model receives, and it had no coverage
  at all. A defect there is not a crash — the model is shown the wrong contract, then fails to satisfy
  it for reasons no error message explains.

  Eleven tests now pin the emitted schema rather than the fact that a call returned: the required and
  optional split, nested objects and arrays, enums, the primitive type mapping, and both behaviours for
  inputs JSON Schema cannot represent.

  That last pair is the wrapper's actual reason to exist, and it was verified against the schema library
  rather than taken from the comment describing it: by default an unrepresentable input degrades to an
  empty schema instead of throwing, which is the opposite of what the underlying library does on its
  own. Callers who ask for the strict behaviour still get the library's own error, message included.

- c5e78c1: `HandoffOptions.tools` now restricts the receiving agent, as its name always implied.

  Nothing in the package read it. A caller passing `{ tools: ["read_file"] }` — the option was
  presented as an allowlist — got no restriction and no warning, which is worse than an absent option
  because it gives false assurance. It is wired to `SendOptions.activeTools`, the same
  `withToolWhitelist` path `Agent.fork`'s `allowedTools` uses: exact name matching, an empty list
  means the empty set (fail-closed), and omitting the option imposes no restriction.

  Local runtime only — a cloud agent ignores `activeTools`, and the docblock now says so.

- aadc9dd: Seventeen more negative-case tests now identify which failure they caught, and a registry test suite
  stops sleeping to make timestamps differ.

  Most of those assertions turned out to be under-asserting rather than untestable: twelve of them sat
  on errors that were **already typed**, and simply checked that something threw. They now name the
  class, the stable code and a message fragment — which means a change that swaps one failure for
  another is caught, where before any error at all satisfied the test.

  Four remain matched on a message fragment because the underlying error genuinely has no type yet, and
  one of those is filed separately: a public entry point throwing a plain error gives callers nothing to
  branch on but a string that changes whenever someone improves the wording.

  Four more were reclassified out of scope after reading the source rather than the name: they raise
  errors owned by Node, by the schema library, or by a database driver, and pinning a third-party class
  buys little.

  Separately, the live-agent-registry tests slept thirteen times — some to force last-used timestamps
  apart so eviction ordering could be asserted, others to let fire-and-forget cleanup finish. Both are
  now driven by the test clock, a mechanism this same file already used elsewhere and which needed no
  production change. The file runs in a fraction of the time and no longer depends on how busy the
  machine is.

- 3724b43: The rule that turns an agent's name into a tool-safe slug existed twice — once in `handoff.ts`,
  once in `tool-injector.ts` — byte-identical apart from a parameter name, and covered by no test at
  all. Two copies of one rule drift the moment either is adjusted, and nothing would have reported
  it: a handoff tool named one way and a dispatcher expecting another.

  It is now one function with tests describing the behaviour it already had: the `agent-` prefix
  stripped case-insensitively, runs of unsafe characters collapsed to one underscore, underscores
  trimmed from both ends, `"anonymous"` when nothing survives, and a 64-character cap. No result
  changes.

  The input is now bounded before the slug rules run. CodeQL flags one of those expressions as
  polynomial backtracking; stated plainly, the quadratic cost **could not be reproduced** — V8
  resolves 100,000 characters of the worst-case shape in under a millisecond. The bound is defence
  in depth against an engine that does not optimise it, not a fix for a demonstrated exploit, and
  nothing beyond the bound could have reached the 64-character result anyway.

- e699569: **The repository moved to the official `usetheokit` organization.** Every `repository`, `bugs` and `homepage` field now points there, along with the README, `CONTRIBUTING.md`, `SECURITY.md` and the issue templates. Existing clones and any URL already published keep working — GitHub redirects a transferred repository permanently — so this is a correctness fix for the metadata npm renders, not a break.

  **The Apache-2.0 text every package ships was replaced with the official one.** The copy distributed until now had paragraph 4(d) truncated: it read "except as required for describing the origin of the Work and reproducing the content of the NOTICE file", dropping "reasonable and customary use" from the licensed clause. §4(d) governs what a redistributor must do with attribution notices, and the omission narrowed it.

  That matters more than a typo would. The manifests declare the SPDX identifier `Apache-2.0`, which is an assertion that the terms are _the_ Apache-2.0 terms — a licence scanner resolves the identifier and never reads the file. A consumer's compliance review, which does read the file, would find a body that no longer matches the identifier and has no name of its own. Every `LICENSE` in this repository is now byte-identical to the canonical text, with the appendix filled in.

  Nothing else about the terms changed: the licence is the same licence it has always been meant to be, and no package changes what it grants.

- e3f2a82: `@opentelemetry/api` is now declared as an optional peer dependency, so the spans these two
  packages emit can actually reach a collector.

  Both lazily `require("@opentelemetry/api")` from their own directory, but neither manifest
  declared it in any dependency field. Under an isolated `node_modules` layout the specifier is
  therefore not linked under the package, the require throws, the loader caches a `null` tracer,
  and every span degrades to a no-op — silently, with no warning, unlike `@theokit/sdk`, which
  prints one when telemetry is enabled and OTel is absent. For `sdk-cache` that covered both of
  its main paths (`cache.lookup` on every send, `cache.store` on every reply), so an operator
  reading a trace saw no cache activity at all and had no way to tell that from a cache that was
  never consulted.

  The declaration matches `@theokit/sdk`'s: `peerDependencies` plus `peerDependenciesMeta.optional`,
  so nothing is installed for anyone who does not want OTel, and users who do want it get their
  copy linked where the require can find it.

- e3f2a82: Every symbol these packages declare in `exports` now reaches the `.d.ts` they publish.

  Sixty-six declarations across twenty-three published files did not compile, and four entry
  points silently omitted names their own barrel exports — `@theokit/sdk/internal/security`
  dropped seven at once. Runtime was never affected; this is types-only. A consumer with
  `skipLibCheck` on saw nothing, and a consumer running type-aware lint saw every type reached
  through one of them degrade to `error`.

  The cause was `stripInternal`, which deletes a declaration when the literal `@internal`
  appears in ANY leading comment range of it. The tag was being used here to mean "outside the
  semver contract" — `internal/persistence/sqlite-open.ts` said so in those words, on a subpath
  the manifest publishes and a back-compat test pins. The compiler reads it as "erase this", and
  the two meanings only diverge in the published artifact. It now says the semver exemption in
  prose, and the tag is gone from the symbols that are published.

  Two further mechanisms had the same cause and a wider blast radius. A tag in a BARREL header
  deleted the first `export … from` beneath it; a tag in a MODULE header deleted the following
  `import`, so `import { z } from "zod"` vanished and every type it bound became
  `Cannot find name`. Nothing was added to any `exports` map and no `export` line changed — a
  deleted import was never privacy, only a broken declaration.

  `@theokit/sdk-handoff`'s `./internal` entry left `SDKAgent` and `CustomTool` unbound, from a
  different defect: the declaration repair only ever looked at `exports["."]`, so it fixed each
  package's main entry and shipped the rest unrepaired. It now covers every declared subpath, and
  binds the side-effect import form (`import '@theokit/sdk';`) the rollup emits with the names
  stripped out.

  Three gates were widened or added so this cannot return silently: the declaration typecheck
  now covers all 45 published entries rather than 12, a new export-parity check fails when a
  source barrel exports a name the emit omits, and public-API documentation coverage is gated at
  100%.

  Two consequences worth naming rather than discovering. `coerceToKnownAgentRunErrorCode` — the
  boundary helper the 4.x release notes point at as the migration path off the open
  `AgentRunErrorCode` union — was tagged internal and therefore absent from the published types; it
  is now exported and documented, which is a small addition to the public surface. And
  `packages/sdk/typedoc.json` sets `excludeInternal: true`, so the generated API reference gains the
  ~57 symbols whose tags were removed. That is the intended direction: those symbols are published,
  and the reference now says so.

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

## 0.1.2

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

## 0.1.1

### Patch Changes

- 453ad2d: SE43 — system-design audit fixes (public-surface changes).

  - **`@theokit/sdk` (minor):** the shared persistence kernel is now reachable from the sanctioned public `@theokit/sdk/persistence` barrel — `withCwdMutex`, `sanitizeFts5Query`, and `PersistenceSchema` are added (joining `replaceFileAtomic` / `openSqliteResilient` / `atomicWriteText` / `atomicWriteJson`). The `@theokit/sdk/internal/persistence` export is now **deprecated**: it re-exports its full surface unchanged for one release (back-compat) and is scheduled for removal in a future major. No breaking change; existing imports keep working.
  - **Satellites (patch):** `sdk-tools` / `sdk-memory` / `sdk-cache` / `sdk-handoff` / `sdk-budget` tightened their `@theokit/sdk` peer-range floor from `>=1.7.0` to `>=4.0.0`, matching the v4-only surfaces they import (prevents a non-workspace install resolving an incompatible old sdk).

All notable changes to `@theokit/sdk-handoff` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(No unreleased changes.)

## [0.1.0] — 2026-06-08

### Added

- Initial extraction from `@theokit/sdk@1.7.0` `src/handoff.ts` + `internal/handoff/` + `types/handoff.ts`.
- Public API: `Handoff.create(target, opts?)`, `Handoff.asPlugin({ targets, maxHandoffDepth? })`, `handoffTo(agent, opts?)`.
- Errors (loop protection): `HandoffLoopError`, `HandoffPairLoopError`, `HandoffSelfReferenceError`, `HandoffReceiverDisposedError`, `HandoffNameCollisionError`.
- Sub-path `@theokit/sdk-handoff/internal/tool-injector` — used by `@theokit/sdk` to lazy-load the dispatcher when consumers use the transitional `Agent.create({ handoffs: [...] })` option.
- Peer-deps: `@theokit/sdk@>=1.7.0`, `zod@^3.25.0 || ^4.0.0`.

### Notes

- The `Handoff.asPlugin()` factory is the **preferred** API in 2.x. The legacy `Agent.create({ handoffs: [...] })` option still works while `@theokit/sdk-handoff` is installed (optional peer model), but the codemod marks every call site with a `CODEMOD` comment. Plan removes the option in the 2.0.0 cohort bump.
- Inline `to-json-schema.ts`: sdk-handoff/src/internal/to-json-schema.ts is a 126-LOC duplicate of `@theokit/sdk` `internal/zod/to-json-schema.ts`. Reason: rollup-plugin-dts emits incomplete declaration files for newly-added internal/ barrels in `@theokit/sdk` (consistent bug — affected observability, security; would affect zod too). Inlining sidesteps the bug AND keeps sdk-handoff self-contained.
