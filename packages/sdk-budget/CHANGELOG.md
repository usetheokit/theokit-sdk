# Changelog — @theokit/sdk-budget

## 0.3.6

### Patch Changes

- [#1373](https://github.com/usetheokit/theokit-sdk/pull/1373) [`18b1e2d`](https://github.com/usetheokit/theokit-sdk/commit/18b1e2d4e8e6d41adc98e62efe395f26e4f1c90d) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - Report `heldUsd: 0` in `snapshotAll` so its snapshots satisfy the widened `BudgetSnapshot` type.

## 0.3.5

## 0.3.5-next.1

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

## 0.3.5-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 0.3.4

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

## 0.3.3

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

## 0.3.1

### Patch Changes

- 453ad2d: SE43 — system-design audit fixes (public-surface changes).

  - **`@theokit/sdk` (minor):** the shared persistence kernel is now reachable from the sanctioned public `@theokit/sdk/persistence` barrel — `withCwdMutex`, `sanitizeFts5Query`, and `PersistenceSchema` are added (joining `replaceFileAtomic` / `openSqliteResilient` / `atomicWriteText` / `atomicWriteJson`). The `@theokit/sdk/internal/persistence` export is now **deprecated**: it re-exports its full surface unchanged for one release (back-compat) and is scheduled for removal in a future major. No breaking change; existing imports keep working.
  - **Satellites (patch):** `sdk-tools` / `sdk-memory` / `sdk-cache` / `sdk-handoff` / `sdk-budget` tightened their `@theokit/sdk` peer-range floor from `>=1.7.0` to `>=4.0.0`, matching the v4-only surfaces they import (prevents a non-workspace install resolving an incompatible old sdk).

## 0.3.0

### Minor Changes

- 32180fe: M7 (Tema F) — `formatCostUsd(cost, opts?)`: honest-null cost render helper. An unknown cost (`undefined`, from `computeUsdCost`/`getTotalUsd`) renders as `"—"` (never a dishonest `"$0"`); a real number renders as `"$X.XX"`. A known-zero `0` is distinct and renders `"$0.00"`.

## 0.2.0

### Minor Changes

- 1706517: M1-6 — multi-round usage aggregation is honest-null (plan `m1-usage-honest-null`).

  Fixes a cost-honesty bug: `computeUsdCost` returned `0` for an unknown model, so a per-round cost that is genuinely UNKNOWN was silently summed as `$0`, making `createUsdBudgetTracker.getTotalUsd()` report a dishonest cheap/complete total and a `maxUsd` cap evaluate against an under-counted spend.

  - `computeUsdCost(...)` now returns `number | undefined` — `undefined` for an unknown model (a known model with zero tokens still returns a real `0`). Aligns with the cost contract (`D377-cost-status-closed-enum.md`: amount-unknown ≠ `$0`), matching `@theokit/sdk/messages`' `costAmountUsd`.
  - `createUsdBudgetTracker` POISONS the aggregate: once any round's cost is unknown, `getTotalUsd()` returns `undefined` (and stays undefined — a later known round does not resurrect it). Tokens are always known and still counted.
  - `check()` FAILS CLOSED on a `maxUsd` cap when cost is unknown (returns `cost_limit` — it cannot prove the run is under budget). The `maxTokens` cap is unaffected.

  **Type change:** `computeUsdCost` and `getTotalUsd()` now return `number | undefined` (was `number`). Consumers must branch on `undefined` (the point of the honest-null contract).

## [Unreleased]

### Fixed

- **Multi-round usage aggregation is honest-null (M1-6).** `computeUsdCost` returned `0` for an unknown model, so a per-round cost that is genuinely UNKNOWN was silently summed as `$0` — making `getTotalUsd()` report a dishonest cheap/complete total and a `maxUsd` cap evaluate against under-counted spend. Now: `computeUsdCost(...): number | undefined` returns `undefined` for an unknown model (a known model with zero tokens still returns a real `0`); `createUsdBudgetTracker` poisons the aggregate so `getTotalUsd(): number | undefined` returns `undefined` once any round's cost is unknown (sticky; tokens still counted); `check()` fails closed on a `maxUsd` cap when cost is unknown (`cost_limit`). Aligns with the cost contract `D377-cost-status-closed-enum.md`. **Type change:** `computeUsdCost`/`getTotalUsd()` now return `number | undefined`.

### Added (Phase 2 physical Stage 1 — iter 19, 2026-06-08)

- Physically-extracted Budget internals into `sdk-budget/src/internal/`:
  - `calendar-window` — UTC-aligned 1h/1d/1w/30d/365d window helpers.
  - `enforcement` — `preflightCheck` + `chargeAndCheckThresholds` with
    onThreshold + onExceed dispatch.
  - `ledger` — `charge` + `spentIn` ledger ops (consumes the new public
    `withCwdMutex` utility from `@theokit/sdk` per ADR-008).
  - `normalize-usage` — `inferApiMode` + `normalizeUsage` (Anthropic /
    OpenAI Chat / OpenAI Responses shape detection).
  - `registry` — `createBudget` / `getBudget` / `listBudgets` /
    `deleteBudget` / `snapshotAll` / `defaultMode` / `getBudgetOptionsRaw`.
- Public exports added to the main barrel:
  `createBudget, defaultMode, deleteBudget, getBudget, getBudgetOptionsRaw,
listBudgets, snapshotAll, chargeAndCheckThresholds, preflightCheck,
inferApiMode, normalizeUsage, startOfDayUtc, startOfWeekUtc,
windowStartMs, charge, spentIn`.

### Changed (iter 19)

- Package now ships ~568 LOC of canonical Budget logic (was 0 LOC pre-Stage-1).
- Bundle size: 2.51 KB → 13.47 KB ESM (the extracted internals).
- `peerDependency`: `@theokit/sdk >= 1.7.0` confirmed (ADR-008's
  public `withCwdMutex` is required).

## [0.1.0] — 2026-06-08

### Added

- Initial release. Consumes the `BudgetTracker` port from `@theokit/sdk@>=1.7.0`
  (SDK 2.0 Phase 2 / T2.X).
- `createUsdBudgetTracker({ maxTokens?, maxUsd?, pricing? })` — USD-cost-
  aware tracker extending sdk-core's counter-based reference.
  `check()` returns `cost_limit` reason when `maxUsd` is exceeded.
- `BUILTIN_PRICING` (read-only) — built-in pricing table for 9 popular
  models across OpenAI / Anthropic / Google (verified 2026-06).
- `computeUsdCost(pricing, model, type, tokens)` — pure helper.

### Notes

- Live-rate fetching / ledger persistence / per-user aggregation deferred
  to future versions. This release ships the package foundation + a
  working USD impl so the SDK 2.0 cohort can publish (Phase 7).
- `peerDependency`: `@theokit/sdk >= 1.7.0` (where the port shipped).
