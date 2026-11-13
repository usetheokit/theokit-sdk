# Changelog

## 4.0.3

### Patch Changes

- [#1147](https://github.com/usetheokit/theokit-sdk/pull/1147) [`9793bc8`](https://github.com/usetheokit/theokit-sdk/commit/9793bc8b28b94e25a094b28073cf0ec403bcb7be) Thanks [@aifactory-paulohenriquevn](https://github.com/apps/aifactory-paulohenriquevn)! - `theokit inspect` now lists plugins by calling the SDK's `listWorkspacePlugins`, so it shows exactly what an agent started in the same directory would load. It no longer lists `~/.theokit/plugins` (the runtime never reads it), and it recognises `.claude-plugin/plugin.json` and `plugin.json` manifests. Plugin entries no longer carry `description`, and `source` is always `project`.

## 4.0.2

### Patch Changes

- Updated dependencies [eae788a]
- Updated dependencies [667bd3d]
- Updated dependencies [070ee92]
- Updated dependencies [131ab8b]
- Updated dependencies [88e87d0]
- Updated dependencies [33aa170]
- Updated dependencies [85b5c2f]
- Updated dependencies [edfa59c]
- Updated dependencies [e7cf2dd]
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
- Updated dependencies [7b4063b]
- Updated dependencies [0c4df84]
- Updated dependencies [618cd02]
- Updated dependencies [01630ec]
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
- Updated dependencies [ae2a720]
- Updated dependencies [edfa59c]
- Updated dependencies [266ffc8]
- Updated dependencies [e0a1ab9]
- Updated dependencies [edfa59c]
  - @theokit/sdk@5.0.0

## 4.0.2-next.1

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

## 4.0.2-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0
  - @theokit/acp@4.0.1-next.0

## 4.0.1

### Patch Changes

- 5f048cf: Drops `zod` from the CLI's dependencies. Nothing in the package imported it — `eval.config`
  validation is three hand-written checks, and the source already said so in a comment. Scaffolded
  templates that use zod declare their own pin, so `theokit init` is unaffected.

  It stayed hidden because the dead-dependency check counted it as satisfying the SDK's zod peer
  requirement. Once the SDK declared zod itself (#399), nothing was left claiming this one, and it
  surfaced immediately. Verified by removing it: the CLI typechecks and all 216 tests pass.

- Updated dependencies [18a68a0]
- Updated dependencies [43e4247]
- Updated dependencies [b85dab4]
- Updated dependencies [4565e43]
  - @theokit/sdk@4.57.0

## 4.0.0

### Major Changes

- 0258f3c: Two `theokit` flags that were advertised in `--help` and read by nothing now behave.

  `tasks cancel --reason <r>` records the reason: `TaskHandle` gains a `cancelReason` field, written
  alongside `cancelledAt` for a queued task and alongside `cancelRequested` for a running one. A task
  that is already terminal is left untouched, reason or not.

  **Breaking:** `theokit init --here` is removed. It never scaffolded into the current directory, and
  the writer cannot honour it — the tree is built in a temp directory and moved into place with `rm` +
  `rename`, so a destination equal to `cwd` would mean deleting the directory the process is running
  in. An unknown-option error is immediate and clear where silence was not.

- 89b25f1: **Breaking:** `theokit setup gworkspace --writable <products>` is removed.

  It granted nothing. The value was never parsed, never validated and never reached upstream; its
  entire effect was a note printed after the OAuth flow had already completed, and only on one of the
  three code paths. A permissions flag that does not affect permissions misleads in the dangerous
  direction — a user reading `--help` concludes they chose a narrow grant while the consent screen
  grants every scope upstream asks for.

  Scope narrowing is not something this command can do: OAuth is delegated upstream (ADR D345) and
  the upstream server offers no per-product grant. That fact now lives in the command's own
  documentation, where it applies to every path rather than to one printed note.

### Minor Changes

- 7c7b21a: `theokit init` gains four templates — `chatbot`, `multi-agent`, `rag-agent` and
  `workflow-automation` — and its `telegram-bot` template now installs and
  compiles. It imported `createAgentFactory`, which the SE36 rename replaced with
  `AgentFactory.create`, and pinned `@theokit/gateway` to the SDK's own version, so
  a scaffolded project failed at `pnpm install` before any code ran.

  `@theokit/cli` exports the `eval.config.ts` contract its README tells you to use:
  `EvalConfig`, `DatasetEntry`, `Scorer` and `Score`.

  `@theokit/sdk` exports `Workflow`, `fn` and `agentStep` from the package root.
  `CronCreateOptions.workflow` types against the copy in the cron chunk, while the
  `./workflow` subpath emits its own declaration of the same class — so a workflow
  built the documented way was rejected by `Cron.create` on a private-field
  mismatch. Importing both from the root now gives one identity.

### Patch Changes

- cdb517f: `theokit init` now exits 2 for a symlinked destination, not 1.

  `theokit --help` publishes `0=success · 1=unknown error · 2=user error`, and a CI job branching on
  that pair routed a plain user mistake to the branch that pages someone. Four of the scaffolder's
  five coded refusals mapped to 2; `dest_is_symlink` was missing from the hand-written copy of that
  list and fell through.

  The list now lives with the scaffolder as a typed union, so adding a refusal without deciding its
  exit code does not compile.

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

- 63a77c6: `theokit eval --output report.md` no longer emits a lone UTF-16 surrogate when a
  dataset input or model output is truncated (#342). The cut counted code units, so
  a boundary landing between the halves of an emoji kept one half — a lone
  surrogate has no UTF-8 encoding, so writers and markdown renderers downstream
  either substitute U+FFFD or reject the file.

  Truncation now cuts only on a character boundary. The width budget stays in code
  units, since it exists to keep the table narrow; what changed is where the cut may
  fall.

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

- f692988: The reference docs no longer ship inside the package. `node_modules/@theokit/sdk/docs/` is gone, along with the `harness-capability-map.md` and `error-codes.md` files it carried — the `docs` entry was removed from the published `files` list and the build step that generated it was removed with it.

  The exported TypeScript types are now the only reference surface, and they remain the canonical contract: every public primitive carries its import path, signature and JSDoc example, surfaced by your editor. Nothing about the runtime API changed.

  The scaffolded agent context still ships, unchanged, under `claude-template/`.

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

- Updated dependencies [1cb6607]
- Updated dependencies [034da4d]
- Updated dependencies [803e3ef]
- Updated dependencies [2ba468b]
- Updated dependencies [92a9d6a]
- Updated dependencies [2c33d98]
- Updated dependencies [ce6a591]
- Updated dependencies [aea04f4]
- Updated dependencies [1471fd7]
- Updated dependencies [0258f3c]
- Updated dependencies [521f8c7]
- Updated dependencies [d0c800c]
- Updated dependencies [969b36e]
- Updated dependencies [ba8ebeb]
- Updated dependencies [d610c2a]
- Updated dependencies [e3f2a82]
- Updated dependencies [e368fc1]
- Updated dependencies [3ac2b08]
- Updated dependencies [d485b4e]
- Updated dependencies [29ebaa1]
- Updated dependencies [0bc18f6]
- Updated dependencies [b5b5e77]
- Updated dependencies [14ccb69]
- Updated dependencies [fbf6721]
- Updated dependencies [1ac974f]
- Updated dependencies [240ae12]
- Updated dependencies [da98560]
- Updated dependencies [181967f]
- Updated dependencies [510ee70]
- Updated dependencies [1362583]
- Updated dependencies [f33b52b]
- Updated dependencies [2cdadcc]
- Updated dependencies [1c94ad3]
- Updated dependencies [398e7a0]
- Updated dependencies [3ad398d]
- Updated dependencies [a8cf443]
- Updated dependencies [aadc9dd]
- Updated dependencies [a1cae95]
- Updated dependencies [8226bc6]
- Updated dependencies [e699569]
- Updated dependencies [8d1feaa]
- Updated dependencies [6950332]
- Updated dependencies [9e6828e]
- Updated dependencies [9a27a72]
- Updated dependencies [e3f2a82]
- Updated dependencies [f692988]
- Updated dependencies [ac08996]
- Updated dependencies [4556488]
- Updated dependencies [566615c]
- Updated dependencies [96b28ba]
- Updated dependencies [f53ee6a]
- Updated dependencies [1af99fa]
- Updated dependencies [8f8d3eb]
- Updated dependencies [4397a90]
- Updated dependencies [883f473]
- Updated dependencies [36e5879]
- Updated dependencies [b68704b]
- Updated dependencies [7c7b21a]
- Updated dependencies [9ab1f0d]
- Updated dependencies [464c390]
- Updated dependencies [c7385d2]
- Updated dependencies [9f5cc20]
- Updated dependencies [5fac0f6]
- Updated dependencies [e685ccb]
- Updated dependencies [7fd8c7e]
- Updated dependencies [60010b4]
- Updated dependencies [25b7eee]
  - @theokit/sdk@4.54.0
  - @theokit/acp@4.0.0

## 3.0.2

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

## 3.0.1

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

- Updated dependencies [e080296]
- Updated dependencies [b9bf261]
- Updated dependencies [8790f70]
  - @theokit/sdk@4.43.0

## 3.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@4.0.0
  - @theokit/acp@3.0.0

## 2.0.1

### Patch Changes

- SE38 (#116) — `theokit init` scaffold templates (`minimal`, `ollama-local`,
  `telegram-bot`) now pin `zod@^4.0.0` instead of `^3.25.0`. The SDK imports the top-level
  `toJSONSchema` export (zod v4 only; under 3.25 it lives at `zod/v4`) and its peer already
  required `zod@^4`, so the old pin resolved to v3 and crashed a scaffolded project with
  `does not provide an export named 'toJSONSchema'` on the first `Tool.create`. A regression
  test derives the required major from the SDK's own `peerDependencies.zod` so a template can
  never drift below the peer again.
- Updated dependencies
  - @theokit/sdk@3.7.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@3.0.0
  - @theokit/acp@2.0.0

## 1.0.0

### Patch Changes

- Updated dependencies [b9f30a6]
  - @theokit/sdk@2.0.0
  - @theokit/acp@1.0.0

## [Unreleased]

### Added

- `theokit db` subcommand wrapping drizzle-kit (Plan `usetheo-orm-v1` Phase 6.5). Subcommands: `generate`, `migrate`, `studio`, `push`, `export-schema`, `check-schema-drift`. Schema commands consume `orm.config.ts` (default-exports `{ schema }`) and invoke `@theokit/orm/schema-export` to emit JSON Schema 7 per entity to `.theokit/schema/{entity}.schema.json`. `check-schema-drift` diffs fresh vs committed schemas and exits 1 on drift — wires into CI as a polyglot-safety gate.

## 2.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@1.3.0
  - @theokit/acp@2.0.0

## 1.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@1.2.0
  - @theokit/acp@1.0.0

## [Unreleased]

### Added (`theokit tasks` — observable async work registry, ADRs D361-D374)

- New top-level subcommand `theokit tasks {list|inspect|cancel}` reads the
  `JsonFileTaskStore` at `$THEOKIT_HOME/tasks/` (fallback: `cwd/.theokit/tasks`).
  Reports CLI exit codes: 0 success, 2 permission/IO, 3 invalid id grammar,
  4 task not found.
- `theokit tasks list [--state S] [--kind K] [--json]` — table or JSON view.
- `theokit tasks inspect <id> [--json]` — full handle dump.
- `theokit tasks cancel <id> [--reason R]` — cross-process best-effort cancel via
  the `cancelRequested` flag on the JSON-backed handle. The owning Node process
  (the one that submitted the task) honors the flag at the next checkpoint
  (EC-7). Queued tasks transition directly to `cancelled`. Terminal tasks
  print `task already terminal` and exit 0.
- 12 unit tests under `tests/commands/tasks.test.ts` covering fresh-install
  ENOENT (EC-6), invalid id grammar, not-found, and the 3 cancel paths.

### Added (`theokit acp` — ACP server adapter, ADRs D349-D360)

- New top-level subcommand `theokit acp` launches a stdio ACP server pointing at
  the entry file's default-exported `SDKAgent` or factory. Used by Zed,
  Cursor, Claude Desktop, and any [Agent Client Protocol](https://agentclientprotocol.com)
  host.
- `--entry <path>` reuses the same resolver as `theokit dev` (D357). Default:
  `src/index.ts` or `package.main`.
- `--permission ask|auto|deny` controls tool gate (default `ask`). `--trusted-tools`
  bypass list. `--permission-timeout-ms` overrides the 60 s default (EC-2 absorbed).
- CJS/ESM interop fallback (`mod.default ?? mod`) so consumers using
  `module.exports = factory` work without contortions (EC-4).
- `@theokit/acp` listed as an OPTIONAL peer dependency — install only when you
  need the subcommand: `npm i @theokit/acp`.
- 4 new tests in `tests/commands/acp.test.ts` covering entry resolution, default
  export fallback, permission flag validation.

### Added (Roadmap v1.4 #5 — `theokit setup gworkspace`, ADRs D340-D348)

- New top-level subcommand `theokit setup <domain>` (ADR D346) with `gworkspace`
  as the first concrete domain. Future domains follow the same pattern.
- `packages/cli/src/commands/setup.ts` + `packages/cli/src/setup/gworkspace.ts` —
  walkthrough that validates `~/.google-mcp/credentials.json` BEFORE delegating
  to upstream `npx google-workspace-mcp setup` + `accounts add`.
- EC-1 (MUST FIX): rejects Web-type OAuth client up-front with actionable error.
- EC-2: rejects malformed JSON with parse-error message.
- EC-3: `--probe` mode caps each upstream call at 10s.
- Path-traversal guard on `--credentials-path` (D80 pattern).
- 8 new tests in `tests/setup/` (credentials-check + dispatch).

### Added (T0.1 — workspace scaffolding, Adoption Roadmap #1)

- New workspace package `@theokit/cli` — developer CLI for `@theokit/sdk`.
- `bin: theokit` registered; executable shim at `src/bin/theokit.ts`.
- Programmatic API: `main(argv): Promise<number>` returns exit code.
- Build-time constants `SDK_VERSION` / `CLI_VERSION` injected via tsup
  `define` (EC-L fix — never `workspace:*` in scaffolded projects).
- `"files": ["dist", "templates", "README.md", ...]` in package.json
  (EC-C MUST FIX — ensures templates ship in the published tarball).
- Smoke tests + tarball-contents guard.

Subcommand surface (`init`, `dev`, `inspect`, `eval`) ships in T1.1-T5.1.
