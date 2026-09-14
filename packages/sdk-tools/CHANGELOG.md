# Changelog

## 0.27.5

### Patch Changes

- [#664](https://github.com/usetheokit/theokit-sdk/pull/664) [`d18d0d8`](https://github.com/usetheokit/theokit-sdk/commit/d18d0d8237ee26315b6693947bd2a476a1e004b0) Thanks [@usetheodev](https://github.com/usetheodev)! - A V4A patch opening with `*** Begin Patch ***` now gets an error that names the near miss.
  
  The message was `Invalid patch: missing '*** Begin Patch'`. That is true about the exact match and
  misleading about the text on screen: the symmetric form CONTAINS the string it says is missing, so a
  writer greps for an absent line while the defect is three characters at the end of a line already
  there.
  
  Measured on a live run: a model wrote the symmetric form by analogy with the `*** Add File: …`
  headers this format also uses, spent three attempts against the old message, and abandoned the step.
  The analogy is the reason the mistake is common — every other marker in V4A carries a trailing
  token, and this one does not.
  
  The variant is **not** accepted. V4A is parsed by other tools, and widening it here would make a
  patch this runtime writes unreadable elsewhere. The error teaches the exact spelling instead: it
  quotes the offending line back and says which part to drop.
  
  Detection is a near-miss test — a line that starts with the marker and is not equal to it — so it
  also covers `*** Begin Patch v2` and any other trailing suffix, not the one spelling that prompted
  it. A patch with no marker at all keeps the original message.

## 0.27.4

## 0.27.4-next.1

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

## 0.27.4-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 0.27.3

### Patch Changes

- 09f3d05: Record that the vitest JSON-report contract `run_vitest` depends on was measured across majors 2, 3 and 4, rather than assumed.

  The peer range is unbounded (`vitest >=2.0.0`) and the tool shells out to `npx --no-install vitest run --reporter=json`, reading four fields off the report's top level without validation. Nothing imports vitest, so no compiler notices a renamed field — the docblock warned about that risk and nobody had checked it.

  Measured 2026-08-31: the same suite under 2.1.9, 3.2.7 and 4.1.11 emits `numTotalTests`, `numPassedTests`, `numFailedTests` and `success`, correctly, every time. Two majors above the declared floor are published and the promise holds.

  Documentation only — no behaviour changes. The docblock now states what was checked, and that the observation expires when vitest 5 ships.

## 0.27.2

### Patch Changes

- 1a4bbcf: The declared `@theokit/sdk` peer range stops promising a version the package does not compile against.

  It declared `>=4.19.3` and fails at exactly that floor, with `error TS2552: Cannot find name`. npm
  resolves the combination with no `ERESOLVE` and no peer warning, and the break surfaces in the build,
  far from the range that caused it.

  The real floor is `4.54.0`, measured by bisecting the 116 stable 4.x releases with a real build as the
  oracle: `4.53.1` fails and `4.54.0` passes. They are adjacent in the published list, so this is the
  exact version rather than an interval.

  This package had been excluded from the sibling finding (usetheokit/theokit-sdk#423) for declaring a
  narrower range than the other four. A narrower range can still be false — it is just false over a
  smaller interval (usetheokit/theokit-sdk#425).

## 0.27.1

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

- 434b25f: `edit_file` wrote its backup to `<path>.bak` with `copyFile`, and the project-root guard that
  validates `path` never looked at that second path. An attacker who could place a file inside the
  workspace ahead of the edit — which is the ordinary situation for an agent working on a repository
  it did not write — could plant a symlink there and have the backup written through it, anywhere on
  the filesystem the process could reach.

  Reproduced before the fix: a symlink at `<path>.bak` pointing outside the project root received the
  file's contents, and `edit_file` reported success.

  The backup is now opened with `O_NOFOLLOW`, so the kernel refuses a symlink outright rather than a
  check deciding it is safe and the write happening a moment later. An existing **regular** `.bak` is
  still overwritten, so the documented behaviour is unchanged for every legitimate edit.

  When the path is refused, the tool returns `{ ok: false, error: "unsafe_backup_path" }` and **does
  not perform the edit**. An edit that silently proceeded without the backup the caller asked for
  would be the quieter bug.

- 9e1b0f7: `git_status` with an injected sandbox now asks the backend whether there is a repository, instead of
  probing the host.

  A session whose checkout lives inside the backend got `{ ok: false, error: "not_a_repo" }` for a
  repository that was perfectly present where the command would have run — while `git_diff`,
  configured identically in the same session, worked. `not_a_repo` exists so the model cannot read "no
  repository" as "nothing changed", so being wrong about it is worse than being unavailable.

  The path-scope check also moves ahead of the probe: a traversal attempt in a confined session used
  to be answered `not_a_repo` rather than `path_traversal`.

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

- 8226bc6: Fourteen negative-case tests now identify which guard fired, and a scheduled job keeps test-order
  independence honest.

  Assertions that only checked "something threw" now assert the error class, its stable code and a
  message substring — for concurrency validation, retry configuration, path traversal, filename
  validation and credential loading. Each conversion was verified by mutating the production error's
  code and watching the corresponding test fail, so the assertions are pinned to the real constants
  rather than to a copy of them.

  Forty-five remaining sites are deliberately left alone and grouped with reasons: ten raise validation
  errors owned by a third-party schema library, thirteen surface Node's own errors, and twenty-two are
  plain untyped errors in our code where there is no class or code to assert yet.

  Separately, the suite runs one file at a time, and a comment in the configuration said that was
  covering up a leak. Measured: with file-level parallelism restored the suite is fully green, twice
  over — the two leaks that comment named have since been fixed. Restoring _within-file_ concurrency
  plus randomised order does still fail, reproducibly, in one file that shares a mutable counter
  between its cases; that is filed on its own and is not fixed here.

  The default gate is unchanged. A separate weekly job runs the suite in shuffled order so the
  remaining coupling keeps surfacing instead of staying suppressed by the serial default.

  Also documented for contributors: what makes a wait trustworthy, and why a premise that justifies
  deleting something needs checking in a way that a premise justifying keeping something does not.

- e699569: **The repository moved to the official `usetheokit` organization.** Every `repository`, `bugs` and `homepage` field now points there, along with the README, `CONTRIBUTING.md`, `SECURITY.md` and the issue templates. Existing clones and any URL already published keep working — GitHub redirects a transferred repository permanently — so this is a correctness fix for the metadata npm renders, not a break.

  **The Apache-2.0 text every package ships was replaced with the official one.** The copy distributed until now had paragraph 4(d) truncated: it read "except as required for describing the origin of the Work and reproducing the content of the NOTICE file", dropping "reasonable and customary use" from the licensed clause. §4(d) governs what a redistributor must do with attribution notices, and the omission narrowed it.

  That matters more than a typo would. The manifests declare the SPDX identifier `Apache-2.0`, which is an assertion that the terms are _the_ Apache-2.0 terms — a licence scanner resolves the identifier and never reads the file. A consumer's compliance review, which does read the file, would find a body that no longer matches the identifier and has no name of its own. Every `LICENSE` in this repository is now byte-identical to the canonical text, with the appendix filled in.

  Nothing else about the terms changed: the licence is the same licence it has always been meant to be, and no package changes what it grants.

- f7311b0: When a tool's output exceeds its budget, the full untruncated output is written to an overflow
  file. That file's name was `overflow-<timestamp>-<8 hex characters>.txt`: eight characters is 32
  bits, and the rest of the name is a clock reading anyone can predict. The write itself followed
  symlinks, so a guessed name planted ahead of time would have received the content — and by
  construction that content is the largest thing the tool produced.

  The name now carries a full UUID, and the file is created exclusively (`O_CREAT|O_EXCL`), which
  POSIX requires to fail when the path already exists, symlinks included. There is no longer a window
  between deciding a path is safe and writing to it.

  No behaviour changes for any caller: the overflow path is still returned in the truncation trailer,
  and it is still unique per truncation.

- f692988: The reference docs no longer ship inside the package. `node_modules/@theokit/sdk/docs/` is gone, along with the `harness-capability-map.md` and `error-codes.md` files it carried — the `docs` entry was removed from the published `files` list and the build step that generated it was removed with it.

  The exported TypeScript types are now the only reference surface, and they remain the canonical contract: every public primitive carries its import path, signature and JSDoc example, surfaced by your editor. Nothing about the runtime API changed.

  The scaffolded agent context still ships, unchanged, under `claude-template/`.

- 131b497: `run_vitest` now reports `no_vitest` when vitest is not installed, as its contract always said.

  `npx --no-install` starts, complains on stderr and exits non-zero with nothing on stdout, so the
  case reached `unparseable_output` — which reads as "vitest ran and printed something I could not
  parse", sending a reader after a reporter or parser problem instead of a missing dependency.
  `no_vitest` was reachable only when the `npx` binary itself could not be spawned.

  The detection is text matching on npm's complaint, and npm's wording is not a contract: if it ever
  changes, the case falls back to the old `unparseable_output` with the real reason in the payload
  rather than to a wrong answer.

- 3ecc956: The barrel-export smoke test now asserts behaviour, not just that a name is a function.

  It was flagged as redundant with four build gates that supposedly enforce the same public surface.
  Measured, the four do not reach this package at all: two are filtered to a different package by name,
  one hardcodes a path under that package, and the fourth's configuration declares only two workspaces,
  neither of them this one. Proved by renaming an exported factory and running all four — every one
  stayed green, and only this test noticed.

  So deleting it would have removed the only coverage of that surface. It keeps its export checks and
  gains a case that invokes a factory and asserts the tool descriptor it returns — name, description,
  input schema and handler — which is the behavioural assertion no build gate can make.

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

- e1fe586: `view_image` checked a file's size with one path lookup and read its bytes with another. Between
  the two, the path could resolve to something else — so the size cap, which is the only thing
  keeping an unbudgeted image out of an LLM's context, described a file that was not the one
  returned.

  It now opens the file once and both sizes and reads through that descriptor. A descriptor cannot
  be swapped, so the two operations describe the same file by construction rather than by a check
  that can be outrun.

  The descriptor is closed on every path, including the early return when the image is over the cap.

## 0.27.0

### Minor Changes

- c18c655: `createViewImageTool` reaches consumers.

  The tool was committed on 2026-08-14, three days after `0.26.3` went to the registry, and no version
  was cut — so the published `0.26.3` and the source at `0.26.3` were different packages. Anyone
  resolving the range got a build without the image tool, and `@theokit/agents` could not forward what
  its dependency did not ship.

  The measurable cost: TheoCode wrote `packages/agent/src/tools/view-image.ts` by hand — the only local
  tool in a ten-tool registry where the other nine are framework built-ins.

  Note for consumers migrating off a hand-rolled equivalent: this `toModelOutput` returns the image
  block ALONE on success, and leaves a failure as text so the model can read the reason and retry.
  An implementation that also emitted a leading text line will change what the model receives.

## 0.26.3

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

## 0.26.2

### Patch Changes

- a713fc7: `interactive_shell` no longer flattens a session-cap error into
  `interactive_unavailable`.

  `toErrorJson` matched `InteractiveUnavailableError` first, so `MaxSessionsError` — which extends it —
  took that branch and lost `max` and `liveSessionIds`. Those are the only actionable fields in the
  error: without them the model cannot tell a missing backend from a session cap it could clear by
  reusing one of the open sessions, which is exactly what `@theokit/sdk-pty`'s docblock says those
  fields exist for.

  The check is structural rather than `instanceof`, because the class lives in `@theokit/sdk-pty` and
  this package does not depend on it — and the tool takes an injected backend, so any provider
  reporting the same two fields gets the same treatment.

  Measured from a consumer that had forked this tool's entire schema and handler to recover the fields,
  since there is no error seam to override.

## 0.20.1

### Patch Changes

- apply_patch (V4A) M18 review fixes — a security-critical writing tool hardened after adversarial review:
  - **Security:** the forbidden-secret guard now blocks `.env`/`.git`/`node_modules`/`.theo` at ANY path
    depth (not just the first segment) and defeats absolute-path spelling (`<root>/.env`) — closing a hole
    where a nested `sub/.git/hooks/…` or an absolute secret path could be written.
  - **Contract:** every fs error (`EISDIR`/`ENOTDIR`/`EACCES`/…) maps to a typed `{ ok: false, error: 'io_error' }`
    instead of throwing out of the handler (the "always JSON" contract now holds).
  - **Atomicity:** a file touched by two hunks is rejected (`duplicate_target`) — no silent lost-update.
  - **Safety:** Add over an existing file is rejected (`file_exists`); Delete of a missing file is `not_found`.
  - **Matching:** `*** End of File` edits of the last line now apply (eof anchoring made a hint with a
    general-search fallback, fixing the phantom-trailing-newline case).

## 0.20.0

### Minor Changes

- 68d0e7f: `createApplyPatchTool` now parses Codex's **V4A patch grammar** (`*** Begin Patch` … `*** End Patch`;
  `*** Add/Update/Delete File:`, optional `*** Move to:`, `@@`-anchored `+`/`-`/context hunks) instead of a
  unified diff — the format the model actually emits in a Codex-style agent. **BREAKING:** the `{ patch }`
  input is now a V4A patch, not a unified diff. Matching uses a context-tolerant ladder (exact → rstrip →
  trim → unicode) mirroring Codex `seek_sequence`; `@@ <ctx>` anchors the search; `*** End of File` anchors
  to the tail. Applied **strictly atomically** — the whole patch is planned (every file read + new content
  computed + path security-checked) before any write, so a parse error / context mismatch / path violation
  anywhere yields a typed error and ZERO writes (stronger than Codex, which can leave partial writes).
  Add File strips one `+` and always ends with a trailing newline; Update+Move transforms the old content
  and renames. New `internal/v4a-patch.ts` parser/matcher.

## 0.19.0

### Minor Changes

- `createSearchTextTool` gains two ADDITIVE, opt-in options (both default OFF ⇒ existing literal, project-
  scoped behavior unchanged): `regex` — match `query` as a JavaScript RegExp (grep semantics; an invalid
  pattern returns `{ ok: false, error: 'invalid_regex' }` before walking), and `allowAbsolute` — honor an
  absolute `path` scope outside `projectRoot` (Codex read-only "reads-anywhere"; forbidden dirs still
  skipped). Together they let one built-in cover both literal content search and grep-style regex search.

## 0.18.0

### Minor Changes

- `createReadFileTool` gains three ADDITIVE, opt-in Codex-grade capabilities (all default OFF, so existing
  consumers are byte-identical): `lineNumbers` (render a `cat -n` `<n>\t<line>` view so the model can cite/
  edit by line), `offset`/`limit` input params (page through a large file), and `allowAbsolute` (honor an
  absolute path outside `projectRoot` — the Codex read-only "reads-anywhere" sandbox). Security: with
  `allowAbsolute`, the secret guard now blocks `.env`/`.git`/`node_modules`/`.theo` at ANY path depth (not
  just the project-relative first segment), closing an absolute-path exfiltration hole. Opt-in only.

## 0.17.0

### Minor Changes

- c98c40a: Add `createUpdatePlanTool` — a Codex-faithful `update_plan` built-in. The model posts a DECLARATIVE plan
  (an ordered list of steps, each `pending | in_progress | completed`) and refreshes it as work proceeds.
  Surface-agnostic by design: returns STRUCTURED `{ ok, explanation, steps, warning? }` so each surface
  renders the checklist itself (no hard-coded glyphs). Follows Codex's "exactly one step in_progress"
  invariant as a non-fatal `warning` (never rejects), so the agent self-corrects on the next update.
  Distinct from the imperative `createTodolistTool` (add/complete by id) and `createPlanModeTool` (mode
  toggle) — this is the declarative full-plan post.

## 0.16.0

### Minor Changes

- ef00db3: Add `createCurrentTimeTool` — a built-in `current_time` tool. Codex-faithful at the core (Codex's
  `clock.curr_time` returns UTC as `YYYY-MM-DD HH:MM:SS UTC`); this keeps that as the default and adds an
  optional IANA `timezone` (additive superset — omitted ⇒ UTC) plus an unambiguous `iso` instant. Returns
  `{ ok, current_time, iso, timezone }` or `{ ok: false, error: 'invalid_timezone' }`. The clock is
  injectable (`{ clock }`) so the tool is deterministic under test.

## 0.15.1

### Patch Changes

- 4c5bd35: M15 review fixes (injected fs path only; local path unaffected): (1) the backend directory walk in
  `glob_files`/`search_text` decides entry type via `stat` (which follows symlinks), so an in-boundary
  symlink cycle could recurse until PATH_MAX — now depth-capped so it terminates; (2) `edit_file`'s
  backend read mapped every failure to `not_found` — now only a genuinely missing file (`FileNotFoundError`)
  maps to `not_found`; any other read error (e.g. a directory, a permission error) propagates (fail-loud),
  matching the local path's ENOENT-only classification.

## 0.15.0

### Minor Changes

- 324835f: M15 — complete the surface-agnostic tool injection. `search_text`, `glob_files`, and `edit_file` now
  accept an optional `filesystem` (`FilesystemProvider`), joining `shell_exec`/`git_diff` (`sandbox`) and
  `interactive_shell`/`write_stdin` (`interactive`). When a backend is injected the recursive walk / read
  / backup / write go through it in project-relative path space (so the tool runs unchanged on a local
  disk, a cluster container, or a Tauri desktop); when omitted the local `fs` path is byte-identical to
  before. Backward compatibility is proven by conformance tests that run each tool through the real
  `LocalFilesystem`/`LocalSandbox` backends and assert identical output to the local path. Additive — no
  breaking change.

## 0.11.1

### Patch Changes

- 453ad2d: SE43 — system-design audit fixes (public-surface changes).

  - **`@theokit/sdk` (minor):** the shared persistence kernel is now reachable from the sanctioned public `@theokit/sdk/persistence` barrel — `withCwdMutex`, `sanitizeFts5Query`, and `PersistenceSchema` are added (joining `replaceFileAtomic` / `openSqliteResilient` / `atomicWriteText` / `atomicWriteJson`). The `@theokit/sdk/internal/persistence` export is now **deprecated**: it re-exports its full surface unchanged for one release (back-compat) and is scheduled for removal in a future major. No breaking change; existing imports keep working.
  - **Satellites (patch):** `sdk-tools` / `sdk-memory` / `sdk-cache` / `sdk-handoff` / `sdk-budget` tightened their `@theokit/sdk` peer-range floor from `>=1.7.0` to `>=4.0.0`, matching the v4-only surfaces they import (prevents a non-workspace install resolving an incompatible old sdk).

## 0.11.0

### Minor Changes

- SE38 (#119) — `createTodolistTool()` is now session-aware: it scopes its items by the
  run's `ctx.threadId`, so one tool object served to many sessions from a single process
  (the multi-tenant server shape) no longer leaks one session's list into another. When no
  `threadId` is present (single-session CLI usage) every call shares one default session, so
  existing behavior is unchanged. `handler` accepts an optional 2nd `ctx` argument and
  `getItems(threadId?)` is session-scoped — both additive/back-compatible.

## 0.10.0

### Minor Changes

- 2606c98: SE37 — Reasoning ergonomics. Ships `ReasoningTools.create()` (`think`/`analyze` scratchpad tools, from `@theokit/sdk` core, re-exported by `@theokit/sdk-tools`) and a lightweight `AgentOptions.reasoning?: boolean` flag. When `reasoning: true`, the agent gets a chain-of-thought preamble prepended to its system prompt AND the reasoning tools auto-attached, turning a non-reasoning model into a reason→act→observe loop using the SAME model (reuses the existing tool loop; no new runtime). Inert (with a one-time warn) when a native reasoning model is configured (`model.params: [{ id: "thinking" }]`) — native reasoning wins, no double-reasoning. Default off; byte-identical behaviour when unset. Validated REAL on OpenRouter: `reasoning: true` drove the `think` tool and answered the "9.11 vs 9.9" trap correctly (9.9).

## 0.9.1

### Patch Changes

- 9dc221b: SE31 gap closure — wire the read-side file factories to the optional `filesystem` backend. `createReadFileTool` and `createListDirTool` now accept the same optional `filesystem` provider as `createWriteFileTool`, so a per-request / multi-tenant root isolates READS and LISTINGS too (previously only writes routed through the backend). Omitted ⇒ identical current behavior (local process fs). `createGlobTool` / `createSearchTextTool` remain on local fs in v1 — they need recursive traversal the minimal non-recursive `FilesystemBackend` seam does not expose (deferred follow-up).

## 0.9.0

### Minor Changes

- 3af329f: **SE31 — `Filesystem` provider seam (`@theokit/sdk/filesystem`).**

  A pluggable filesystem _storage_ provider, the storage-side twin of `@theokit/sdk/sandbox`. `FilesystemBackend` is an abstract class with four methods (`readFile` / `writeFile` / `stat` / `list`), an `exists()` derived on the base, a boundary `basePath`, a `readOnly` flag, structured `stat().mtimeMs` (the read-before-write oracle for SE32), and typed errors (`FileNotFoundError` / `FilesystemSecurityError` / `FilesystemReadOnlyError` / `StaleFileError`). `LocalFilesystem` is the local-process implementation, boundary-enforced by reusing the core path-guard (traversal + symlink escape → `FilesystemSecurityError`). `FilesystemProvider` + `resolveFilesystem` support a per-request resolver `(ctx) => FilesystemBackend` for multi-tenant roots.

  Unlike `SandboxBackend` (whose file ops shell out via `execute`, require command execution, and give no structured `stat`), a `FilesystemBackend` serves a filesystem-only workspace with no sandbox — see ADR 0011 for why file ops are NOT routed through `SandboxBackend`. `@theokit/sdk-tools`' `createWriteFileTool` now accepts an optional `filesystem` backend (writes route through it; omitted ⇒ identical local-`projectRoot` behavior). This is the backend seam, NOT a bundled `Workspace` and NOT a new toolset — bring-your-own-tools stands; `mounts`/FUSE, S3/GCS, and LSP remain out of core. (SDK Evolution roadmap SE31.)

- 84df83a: **SE32 — read-before-write safety (`requireReadBeforeWrite` + `ReadTracker`).**

  An opt-in guard on `createWriteFileTool` that refuses to blindly overwrite a file the agent has not seen. A per-run `ReadTracker` (exported from `@theokit/sdk-tools`) records each file's mtime when `createReadFileTool` reads it; when `createWriteFileTool` is created with `{ requireReadBeforeWrite: true, readTracker }`, a write is refused with `read_required` if the existing file was never read, or `stale_file` if it changed on disk since it was read. A NEW file writes freely (nothing to clobber). Default OFF — omitting the flag preserves current behavior exactly.

  Works on both the local `projectRoot` path and the SE31 `filesystem` backend path (the backend also gets `expectedMtime` forwarded so it re-checks at write time — TOCTOU defense). The tracker is deliberately per-instance, not a global singleton, so state never leaks across runs. `edit_file` already has implicit read-before-write safety via `old_string` content matching, so the guard targets the blind-overwrite path (`write_file`). Refusals surface as `FileReadRequiredError` / `StaleFileError`. (SDK Evolution roadmap SE32.)

## 0.8.0

### Minor Changes

- ac3f77d: @theokit/sdk: resolveModelCapabilities catalog gains cheap OpenRouter slugs (qwen3-coder, deepseek v4-flash/v3.2, glm-4.7-flash, gemini-2.5-flash-lite/pro) so they resolve real context windows instead of the 4096 default. @theokit/sdk-tools: new createGenericHttpSearchAdapter (env-keyed generic HTTP WebSearchCallback alongside Brave); buildEnvContext gains git-branch detection + an injectable clock. @theokit/sdk-cache: ships createLexicalEmbedder (zero-dependency token-hash lexical embedder built-in).

## 0.7.0

### Minor Changes

- 5bd2f9c: @theokit/sdk: `shouldCompact`/`ShouldCompactInput` gains an optional `maxOutput` output-reserve term (`estimated >= contextWindow - buffer - (maxOutput ?? 0)`), defaulting to today's behavior. `AgentOptions.plugins` now also accepts an array of code `Plugin` objects (matching the runtime + docs), not only `{ enabled }`. @theokit/sdk-tools: `renderToolList` gains an optional `{ mode: "full" | "summary" | "names" }` — `"full"` (default) is the existing `<tools>` XML; `"summary"` renders `- name: <first sentence>`; `"names"` renders `- name`.

## 0.6.0

### Minor Changes

- 6d65983: `createWebFetchTool` gains a redirect policy + injection seam.

  - **`maxRedirects?: number`** — caps redirect hops (each SSRF-screened). Default 5 (unchanged). Set `0` to BLOCK ALL redirects (strict no-redirect policy for untrusted, model-chosen URLs).
  - **Distinct `redirect_blocked` error** — a refused redirect now returns `{ ok:false, error:'redirect_blocked' }`, split from `ssrf_blocked` (a blocked private/reserved host). New exported `RedirectBlockedError`; `screenedFetch` throws it on redirect-limit exhaustion (was `SsrfBlockedError("too many redirects")` — a minor, more-precise error refinement).
  - **Injectable `fetchImpl?` / `lookup?`** — drive the tool's redirect + SSRF paths deterministically in tests with no real network/DNS (the seam `screenedFetch` already had, now on the tool surface).

  Additive + backward-compatible: absent options ⇒ today's behavior; `ssrf_blocked`/`invalid_url`/`timeout`/`too_large` codes + return shape unchanged. Lets a consumer (theocode) replace an app-side SSRF/redirect wrapper with `createWebFetchTool({ maxRedirects: 0 })`.

## 0.5.0

### Minor Changes

- 6dc0e26: Add `withShellExitGuidance` — a guidance wrapper for `shell_exec` soft failures.

  `injectGuidance`/`withDefaultGuidance` inject an actionable `guidance` hint only on `{ ok:false, error }` results (by design). But `shell_exec` returns `{ ok:true, exit_code }` — a non-zero `exit_code` is a SOFT failure (the tool ran, the command failed) that the ok:false-only injector does not cover. `withShellExitGuidance(tool)` wraps `shell_exec` so a `{ ok:true, exit_code≠0 }` result gains a `guidance` hint ("The command exited N. Read the stderr above, fix the cause, then retry."). ADDITIVE, IDEMPOTENT, NEVER-THROW; a no-op for any other tool, for `exit_code 0`, and for non-JSON output. Composes after `withDefaultGuidance` (disjoint domains — no double-injection). Lets consumers drop app-side shell-exit guidance reimplementations.

## 0.4.0

### Minor Changes

- bd10da3: SOTA default descriptions for the 9 built-in tools (`read_file`/`write_file`/`edit_file`/`glob_files`/`search_text`/`shell_exec`/`todolist`/`web_fetch`/`web_search`).

  Each tool's default `description` is upgraded from terse mechanics-only copy to rich, behavior-accurate ACI copy (preconditions, when-to-prefer-which-tool, return shape) — the Agent-Computer Interface the model reads to choose tools, which measurably improves tool-selection. Every claim is verified against the tool's own handler (e.g. `search_text` is described as LITERAL + CASE-SENSITIVE because it matches via `line.includes`; `web_fetch` is described as SSRF-guarded because `screenedFetch` defaults `allowPrivateHosts: false`), so the description lives next to the implementation it describes and cannot drift. Descriptions are generalized (no app-specific cross-tool references). `edit_file` now also ENFORCES the documented `old_string !== new_string` precondition (a no-op edit returns `{ ok: false, error: "no_change" }` instead of a misleading `replacements: 1`), so the description matches behavior. Otherwise no API change: same factory signatures, same return shapes; only the default description string changed. Consumers no longer need to override these descriptions app-side — `withDescription` remains for genuine per-consumer customization. Added `tests/sota-descriptions.test.ts` asserting each description's load-bearing behavioral phrases.

## 0.3.0

### Minor Changes

- 986f340: V3-1 — harden `catastrophicShellReason` to theocode's security-reviewed shell-guard. The `shell_exec` guardrail previously missed 18 of 42 catastrophic commands (empirical probe): `git reset --hard`, `git clean -fd`, secret-file exfiltration (`cat .env | curl`, `tar ~/.aws | nc`), command-substitution / eval RCE (`eval "$(curl)"`, `. <(curl)`, `bash -c "$(curl)"`), `find / -delete` / `-exec rm`, `truncate /dev/sda`, and a range of `rm -rf` targets (`~/sub`, `/usr/local`, `../..`, `$HOME/x`, flags after the operand, any absolute non-scratch path). The rules are ported from theocode's hardened guard (proven by a 42-blocked + 24-allowed corpus at 0 misses / 0 false-positives) as a SUPERSET — the SDK's extra screens (recursive `chmod`/`chown` on a root path, extra block-device families, `//` collapse) are kept, and the segment splitter now also covers `&` and newlines. Reason strings widened to describe each category; the public API (`catastrophicShellReason(cmd): string | null`, `CatastrophicCommandError`) is unchanged. No new dependency.

## 0.2.0

### Minor Changes

- b392b02: M3-5 — ACI description override + render `<tools>` (plan `m3-aci-tools`).

  Two pure, zero-dependency ACI helpers in `@theokit/sdk-tools`:

  - `withDescription(tool, description)` — returns a new `CustomTool` with the LLM-facing description replaced (name/inputSchema/handler preserved); the original tool is not mutated. Tune a built-in tool's wording without re-implementing it.
  - `renderToolList(tools)` — renders a `<tools>` block (name + description per tool) from the SAME `CustomTool[]` the agent runs, so the list cannot drift from the real tools (single source of truth). XML-escaped, empty-safe (`<tools></tools>`), never throws. It is a system-prompt orientation aid — the provider schema stays each tool's `inputSchema`.

  Zero new dependencies.

- 9a7ab99: M3-2 — catastrophic-command guardrail for `shell_exec` (secure by default; plan `m3-catastrophic-shell`).

  `createShellTool()` now screens every command against a segment-aware deny-list **by default**. A command that, in any segment (across `;`/`&&`/`||`/pipe chains, behind `sudo`/`env`, or piped into a shell), matches a catastrophic pattern returns `{ ok: false, error: "catastrophic_command", reason }` instead of executing. The screened set: `rm -rf` of a root/home/glob or top-level system-dir target (`/`, `~`, `$HOME`, `/etc`, `/usr`, … — relative paths like `./build` stay allowed), `curl`/`wget` piped into `sh`/`bash`, `mkfs`, `dd` writing to a device, the `:(){ :|:& };:` fork bomb, `git push --force` (including the `+refspec` form; `--force-with-lease` allowed), `chmod`/`chown -R` on a root path, and redirects to a block device. Matching is at COMMAND POSITION (the executable, not an arbitrary substring), so a mention like `echo "rm -rf /"` is not over-blocked.

  **Behavior change:** agents running catastrophic commands now get `catastrophic_command`. Opt out for legitimate destructive power flows with `createShellTool({ allowCatastrophic: true })`.

  This is a heuristic GUARDRAIL, not a sandbox — it is bypassable by obfuscation and is POSIX-only (Windows PowerShell out of scope). Also exports the reusable primitives `catastrophicShellReason` and `CatastrophicCommandError`. Zero new dependencies (in-house segment tokenizer).

- 51bf3ae: M3-6 — composable command-permission policy layer (plan `m3-command-policy`).

  A small, pure, zero-dependency policy layer that builds on the `shell_exec` catastrophic guardrail (M3-2):

  - `type CommandPolicy = (command) => string | null` — a deny reason, or `null` to allow.
  - `denyCatastrophicCommands()` — a policy composing `catastrophicShellReason` (no duplicated deny-list).
  - `commandDenialReason(command, policies)` — first deny reason across the array (deny-wins); `null` if all allow; an empty array denies nothing.
  - `isCommandAllowed(command, policies)` — the boolean view.

  Framework-agnostic — wire it at your permission layer (e.g. inside a `pre_tool_call` hook). Inherits the guardrail's honesty (a heuristic gate, not a sandbox). Zero new dependencies.

- 6ef9eae: M3-3 — repo-map / env-context builders (plan `m3-repo-map`).

  `@theokit/sdk-tools` now exports two `node:fs`-only, char-bounded, **never-throw** string builders that orient an LLM coding agent in one call:

  - `buildEnvContext(cwd)` — an `<env>` block: working directory, platform/arch, Node version, is-git (detected via the presence of `.git`, no `git` subprocess), today's date, project docs found (`AGENTS.md`/`CLAUDE.md`/`README.md` with a bounded head), and detected manifests.
  - `buildRepoMap(cwd, { budget, ignore, maxDepth })` — a depth-first directory tree bounded by `budget` (default 8000 chars, `… (truncated)` marker), `maxDepth` (default 4), and a per-directory cap. Default ignores (`node_modules`/`.git`/`dist`/`.theo`/`.next`/`build`/`coverage`/`target`/`out` + dot-entries) merge with the caller's `ignore`. Directory symlinks are listed as leaves (not followed) so symlink loops cannot hang the walk.

  Both NEVER throw — a missing/unreadable path yields an `(unavailable)` marker; an unreadable sub-directory is skipped. A best-effort orientation aid (not a complete or `.gitignore`-aware listing — deferred). Zero new dependencies (`node:fs`/`node:path` only).

- 5c40feb: M3-4 — rich tool errors / self-correction guidance (plan `m3-rich-errors`).

  `@theokit/sdk-tools` now exports a composable wrapper that adds an LLM-actionable `guidance` hint to a failing tool result so the model can self-correct:

  - `withToolResultGuidance(tool, guidance)` — wraps any `CustomTool`; on an `{ ok:false, error }` result it adds a `guidance` string from the `guidance` map (keyed by error code), preserving name/description/inputSchema.
  - `withDefaultGuidance(tool)` — pre-bound to `DEFAULT_TOOL_GUIDANCE`, a curated map for the common codes (`not_found`, `path_traversal`, `forbidden_path`, `no_match`, `timeout`, `invalid_url`, `ssrf_blocked`, `catastrophic_command`, `binary_file`, `too_large`).
  - `injectGuidance(output, guidance)` — the pure underlying transform.

  Injection is ADDITIVE (only on `ok:false`), IDEMPOTENT (never overwrites existing `guidance`), and NEVER-THROW: non-JSON output, `ok:true`, non-object JSON, or an unknown code is returned unchanged. Compose over the built-in tools or your own — no factory edits. Zero new dependencies.

- f7f67d0: M3-1 — SSRF guard for `web_fetch` (secure by default; plan `m3-ssrf-guard`).

  `createWebFetchTool()` now screens every request and every redirect hop against an SSRF block-list **by default**. A URL whose host resolves to a private/loopback/link-local/CGNAT/cloud-metadata/reserved address (IPv4 or IPv6, including IPv4-mapped `::ffff:` and DNS names resolving to such) returns `{ ok: false, error: "ssrf_blocked" }`. Redirects use `redirect:"manual"` with per-hop re-screening (a redirect to `127.0.0.1`/`169.254.169.254` is blocked, not followed); non-http(s) redirect targets are rejected. Resolves ALL A-records (multi-record evasion) and unwraps IPv4-mapped IPv6.

  **Behavior change:** requests to localhost/private hosts are now blocked. Opt out for trusted local-dev tooling with `createWebFetchTool({ allowPrivateHosts: true })`.

  Also exports the reusable screening primitives `resolveAndScreen`, `isBlockedIp`, `screenedFetch`, and `SsrfBlockedError`. Node `dns`/`net` builtins only — zero new dependencies.

- 30ad16e: M3-7 — Brave web-search provider adapter (plan `m3-websearch-adapter`).

  `createWebSearchTool` is provider-agnostic; `@theokit/sdk-tools` now ships one concrete env-driven adapter:

  - `createBraveWebSearchAdapter({ apiKey?, fetchImpl?, endpoint? })` — a `WebSearchCallback` backed by the Brave Search API. The key defaults to `process.env.BRAVE_API_KEY` (throws a typed `ConfigurationError` code `no_api_key` at creation if absent — fail-early). `fetchImpl` is injectable (default `globalThis.fetch`) for offline testing. Maps Brave's `web.results[]` to `{ title, url, snippet }` (empty-safe); a non-ok HTTP response throws, which `createWebSearchTool` surfaces as `{ ok:false, error:"search_failed" }`.

  Plug it in with `createWebSearchTool({ search: createBraveWebSearchAdapter() })` — the tool stays provider-agnostic (additional providers like Tavily are a follow-up). Uses a plain `fetch` (the endpoint host is fixed; no SSRF surface). Zero new dependencies.

- 0fe0f28: M4-4 — generic session artifact store + opt-in plan-mode persistence (plan `m4-artifact-store`).

  - `createSessionArtifactStore({ dir, idStrategy?, extension? })` → `{ write, read, has, list, path }`. A generic, id-keyed, atomic artifact store generalizing the per-run session-summary writer. `write(id, content)` persists `<dir>/<idStrategy(id)><extension>` via `replaceFileAtomic` and returns the path; `read` returns the content or `undefined` (never throws); `has`/`list` enumerate; `path(id)` is traversal-safe. Default `idStrategy` is `safeFilenameForId` (+ `safePathJoin`), so a `../escape` id can never write outside `dir`. Reads never throw; writes fail loud. Zero new dependencies.
  - `createPlanModeTool({ artifactStore, artifactId? })` — a new OPT-IN overload whose async handler persists the submitted `plan` to the store on `exit` (returns `{ ok, mode, message, persisted, path }`). The zero-arg `createPlanModeTool()` is unchanged (synchronous handler, no disk). Only a non-empty `plan` on `exit` is persisted; `enter`/`status` never write.

- 0d07f29: M4-5 — `todolist` structured items (latent bug fix) + `todoItemsToPlanNodes` adapter (plan `m4-todo-plan-nodes`).

  - **Fix:** the `todolist` tool returned only a formatted `items_summary` STRING — never the structured `items` array — so a consumer parsing the result to render a plan/UI always recovered `[]`. Every list-bearing result now ALSO carries `items: TodoItem[]` (a snapshot copy), alongside the preserved `items_summary`. `getItems()` + error/`fail` shapes are unchanged.
  - **Add:** `todoItemsToPlanNodes(items: readonly TodoItem[]): PlanNode[]` — a versioned, pure adapter mapping each item to `{ id, label: title, status }` (timestamps dropped, order preserved) + the `PlanNode` type. Replaces consumer-side hand-rolled mappers.

  Zero new dependencies.

All notable changes to `@theokit/sdk-tools` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(No unreleased changes.)

## [0.1.0] — 2026-06-08

### Added

- Initial extraction from `@theokit/sdk@1.7.0` `src/tools/` directory.
- Public factories:
  - `createReadFileTool({ cwd })`
  - `createListDirTool({ cwd })`
  - `createSearchTextTool({ cwd })`
  - `createGitDiffTool({ cwd })` — requires `simple-git` peer
  - `createRunVitestTool({ cwd })` — requires `vitest` peer
  - `createSubprocessTool({ cwd })`
- Path-scope helpers: `checkPathScope`.
- Security: inline `isForbiddenPath` blocklist primitive (avoid coupling to `@theokit/sdk/internal/security`).
- Peer-deps: `@theokit/sdk@>=1.7.0`, optional `simple-git` and `vitest`, `zod@^3.25.0 || ^4.0.0`.

### Notes

- `@theokit/sdk/tools` sub-path is removed in `@theokit/sdk@2.0.0`; consumers move to `@theokit/sdk-tools`.
- All 6 unit tests from `packages/sdk/tests/tools/{git-diff,list-dir,read-file,run-vitest,search-text,sub-export-smoke}.test.ts` migrated.
- Sub-export smoke test rewritten to assert the new package barrel surface.
