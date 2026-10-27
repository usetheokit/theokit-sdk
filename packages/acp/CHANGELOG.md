# Changelog

## 4.0.2

### Patch Changes

- [#763](https://github.com/usetheokit/theokit-sdk/pull/763) [`473616d`](https://github.com/usetheokit/theokit-sdk/commit/473616d2585f11c9c2878a47e17665111279388a) Thanks [@usetheodev](https://github.com/usetheodev)! - `@theokit/acp` and `@theokit/sdk-handoff` keep answering in their protocol when the consumer's agent was created with `throwOnError: true`. When a failed run's `run.wait()` rejects, the ACP handler picks the stop reason from the rejected error's own canonical code (`metadata.code`, else `code`), and the handoff dispatcher replies with `(Handoff target <id> returned status=error: <message>)` using the error's message. This is close to what a resolved error run produces, but not identical: when the run's detail code came from another writer (`agent_loop_failed`, for instance), the error's own code and message are used instead. Any rejection from a run whose status is not `"error"`, such as an abort or an output-processor failure on a finished run, propagates unchanged.
  
  `@theokit/sdk`: a failed run's `result.error.cause` is now always a `TheokitAgentError`, and `RunErrorDetail.cause` is typed that way. A failure with no SDK error behind it (a budget denial, the iteration limit, a hook, a cloud run failure, a non-SDK exception) carries an `UnknownAgentError` with the run's message and code, holding the original value at its own `cause`. `result.error.message` and `result.error.code` are unchanged.
  
  `AgentOptions.throwOnError` now reaches the run itself, as its doc comment promised. `run.wait()` rejects with `result.error.cause`, and so do `agent.generate`, `agent.fork` and `agent.runToCompletion`. `agent.runUntil` and `agent.streamToCompletion` throw it from their iterator, and `Agent.batch` returns it as the failed item's `error`. A workflow `agentStep`, a cron task and an `Eval` row keep recording the failure, now with the typed error's class name, code or message. `Agent.prompt` still rejects with `AgentRunError`, whose `cause` is the typed error. Cancelled and finished runs still resolve, the `postRun` hook still fires on a failed run, and a run nobody awaits raises no unhandled rejection.

## 4.0.1

## 4.0.1-next.1

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

## 4.0.1-next.0

### Patch Changes

- Updated dependencies [01630ec]
  - @theokit/sdk@4.63.4-next.0

## 4.0.0

### Major Changes

- 2c33d98: `AcpServerOptions.info` is now advertised in the `initialize` handshake, and two inert capability
  fields are removed.

  `info` was accepted, typed, and documented as advertised — and read by nothing. It is now sent as
  `InitializeResponse.agentInfo`, the protocol slot that matches its shape. It is omitted when you do
  not supply one: defaulting to this package's own metadata would label every agent as the adapter
  serving it, and a name that is confidently wrong is worse for a host to display than one that is
  absent.

  **Breaking:** `AcpCapabilities.forkSession` and `AcpCapabilities.listSessions` are removed.
  `AgentCapabilities` has no slot for either at `@agentclientprotocol/sdk@0.22.1` — neither name
  appears in its schema — and neither gated anything: `session/fork` is refused unconditionally and
  `session/list` is answered regardless. Setting them never did anything; removing them says so at
  compile time.

### Minor Changes

- 92a9d6a: `InvalidAgentError` is now exported from `@theokit/acp`.

  It is the single startup failure of `serveAcp` and its documented name, but it was not on the
  package's public surface, so a consumer could neither `import` it nor `instanceof` it — leaving
  `err.name` string-matching as the only way to tell a bad `agent` from any other rejection. The
  package's other named error, `PromptTooLargeError`, was already exported "so that text has a named
  origin"; both have the same justification.

### Patch Changes

- 2ba468b: `session/cancel` no longer kills the session.

  The session owned exactly one `AbortController`, created at session creation and never replaced, so
  cancelling one turn handed every later prompt on that session an already-aborted signal. ACP hosts
  routinely cancel a turn and then prompt again: the agent silently stopped answering while the host
  stayed connected and the session stayed listed.

  The abort scope is now armed per turn, which is what `session/cancel` means — the host stops the
  answer being written, not the conversation. Cancelling the turn in flight still works.

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

- 29ebaa1: Three places where a value was reported that nobody had actually selected.

  **An empty `POSTHOG_API_KEY` no longer masks a valid `POSTHOG_PROJECT_API_KEY`.** The adapter read
  `POSTHOG_API_KEY ?? POSTHOG_PROJECT_API_KEY`, and `??` treats `""` as present. Leaving a variable
  blank in a `.env` or a CI config is the ordinary way to say "unset", so a blank primary key silently
  disabled telemetry while a working key sat in the sibling variable — and telemetry going quiet is the
  one failure that reports itself as nothing at all. Empty and whitespace-only values now fall through.
  The same trap on `POSTHOG_HOST` is closed with it.

  **The provider inspector reports the model the route resolves to.** `extractModelName` documented
  itself as surfacing the name from the prefix split and instead returned a hard-coded default, so a
  route configured as `anthropic:claude-opus-4` with no explicit `route.model` reported
  `claude-3-7-sonnet`. That field exists to let a caller confirm which model a route resolves to; a
  wrong answer there is worse than no answer, because it is indistinguishable from a right one. The
  name is now derived from the model id the route actually carries, and the default-model lookup that
  produced the literal is deleted rather than left as a decoy.

  **An errored ACP run no longer reaches the client as `end_turn`.** The stop-reason mapping fell
  through to `end_turn` for any run status it did not recognise, so a failure was reported over the
  wire as an ordinary completed turn — invisible to every ACP client, which is the swallowed-error
  shape the project's error-handling rules forbid by name. The protocol's `StopReason` has no error
  value, so an unmapped status now surfaces through the JSON-RPC error channel the handler already uses
  for every other failure, with a message naming the status that was not mapped. A dead branch
  returning `end_turn` twice is removed in the same pass.

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

## 3.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@4.0.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@3.0.0

## 1.0.1

### Patch Changes

- 98ac0d0: Fix a live security defect: the ACP `pre_tool_call` permission veto was never enforced (#68). `installPermissionPlugin` tried to register its veto hook via `pluginManager.register(...)`, but `PluginManager` exposed no `register()` method — only a single-shot `initialize()` that throws when called twice. The call fell through to `void mgr.initialize([plugin])`, whose "called twice" rejection was swallowed, so the permission hook was never aggregated and guarded tools ran **without** the permission check even under `permissionMode: "deny"`/`"ask"`.

  `PluginManager` now exposes `register(plugin)` — a post-init, `general`-only registration that REPLACES a same-named plugin's hooks (idempotent for the per-prompt ACP re-install) instead of appending duplicates. Additionally, `installPermissionPlugin` is now **fail-closed**: when the runtime has no plugin manager (e.g. a CloudAgent) and the mode is `deny`/`ask`, it throws a `ConfigurationError` (`code: "permission_enforcement_unavailable"`) and the ACP prompt is refused — rather than letting tools run ungated while the operator believes they are gated. It is also now `async` and awaits registration, so the veto hook is guaranteed aggregated before the first tool dispatch (no fire-and-forget window).

## 1.0.0

### Patch Changes

- Updated dependencies [b9f30a6]
  - @theokit/sdk@2.0.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@1.3.0

## 1.0.0

### Patch Changes

- Updated dependencies
  - @theokit/sdk@1.2.0

## 0.1.0

### Minor Changes

- Initial release: ACP server adapter for `@theokit/sdk`. ADRs D349-D360.

  **Added:**

  - **`serveAcp({ agent })`** — block on stdio JSON-RPC ACP server until disconnect.
  - **`AgentFactory = (sessionId) => Promise<SDKAgent>`** — per-session isolation (D351).
  - **Session lifecycle handlers** — `initialize`, `newSession`, `loadSession`, `listSessions`, `cancel`, `prompt`.
  - **Stream translator** — maps `SDKMessage` → ACP `SessionUpdate` with exhaustive switch + `never` check (D353).
  - **Tool permission flow** — `pre_tool_call` veto bridges ACP `requestPermission`; modes `ask`/`auto`/`deny` (D355).
  - **Per-session AbortController** — `cancel` fires session abort; passes through to `agent.send` signal (D354).
  - **Prompt size cap** — 2 MiB default; `PromptTooLargeError` exported (D360).
  - **CJS interop** — bin shim and CLI use `mod.default ?? mod` fallback (EC-4).
  - **Cleanup on stdin close** — every active session disposed before `serveAcp` resolves (EC-1).
  - **Permission timeout** — `permissionTimeoutMs` default 60_000; prevents prompt-hang on unresponsive client (EC-2).
  - **Helpful `load_session` error** — "session not found" message hints at `conversationStorage` for serverless (EC-6).
  - **CWD validation** — absolute path resolved before factory invocation (EC-5).
  - **Bin shim** — `npx theokit-acp` works without installing `@theokit/cli`.
  - **Registry manifest** — `packages/acp/registry/agent.json` for the ACP marketplace.

  **Deferred to v0.2:**

  - `unstable_forkSession` — current SDK fork is a one-shot ephemeral sub-run; proper session split needs `Agent.create()` with parent inheritance (D350).
  - `authenticate` — token/OAuth handshake (D350).
  - JSON-file session persistence (D356).
  - ACP client (calling external ACP agents from inside the SDK).
