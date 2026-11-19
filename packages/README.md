# `theokit-sdk` packages

This monorepo ships the Agent-AI **Harness**, organized in **3 families**. The family lets you find a package by what it does, not by alphabetical position.

> **No version numbers here, on purpose.** They were listed once and every one of the seven went
> stale — `@theokit/sdk` read 4.2.1 against a published 4.53.1, `@theokit/sdk-tools` 0.11.1 against
> 0.27.0. A number labelled "indicative" that is fifty releases out is not a hint, it is a trap for
> anyone pinning from it. Read `package.json`, or `npm view @theokit/<name> version`. `@theokit/sdk`
> is the only 4.x line; the satellites version independently, so their numbers never line up.

> **Monorepo cohesion split (2026-06-18, plan `monorepo-cohesion-split`).** The non-Harness clusters were extracted to sibling repos so the SDK is a coherent harness ("LEGO pieces to build any agent"). See the "Extracted to sibling repos" section below.

> **Looking for a symbol rather than a package?** Two generated references ship inside
> `@theokit/sdk` and are the authority when any prose here disagrees with them:
> `docs/harness-capability-map.md` (every public symbol and the exact specifier to import it from)
> and `docs/error-codes.md` (every `code` an error can carry, and where it is raised). Both are
> regenerated from the built declarations by `pnpm run docs`, so they cannot drift silently.

## Families

### Core — agent runtime + extensions + data layer

| Package | Purpose |
|---|---|
| `@theokit/sdk` | Agent kernel: `Agent.create`, `AgentBuilder`, `AgentFactory.create`, `Tool.create`, runtime loop, plugin foundation, persistence primitives, MCP, hooks, providers, subscription/a2a/sandbox/client/server sub-paths. (SE36 v3.0 collapsed the `define*`/`create*` factories to the uniform `X.create` surface.) |
| `@theokit/sdk-cache` | Semantic LLM response cache, in two modes that behave differently. `consult`/`remember` short-circuit: a hit returns the stored answer and the provider is never called. `asPlugin()` does NOT — it hands the stored answer back as `recalledContext`, which the agent loop injects as a `<memory-context>` block before the prompt, and the request still goes to the provider. Pick the mode by which of those you wanted. |
| `@theokit/sdk-tools` | Built-in tools (read-file, list-dir, search-text, git-diff, subprocess, run-vitest). |
| `@theokit/sdk-memory` | `MemoryProvider` port consumer — markdown store with disk-backed session-summary write/recall + `memory_remember` / `memory_search` tools + agent-scope privacy filter. |
| `@theokit/sdk-budget` | `BudgetTracker` port consumer + USD pricing tracker. |
| `@theokit/skills-registry` | Skill package format (`SKILL.md` folders as JSON), semver version resolution, digest-verified `downloadSkill`, and an atomic `installSkill` that rejects unsafe paths and rolls back a failed swap. |
| `@theokit/sdk-handoff` | Inter-agent dispatch via plugin protocol. `Handoff.asPlugin()` + lazy-loaded `internal/tool-injector`. The receiving agent currently starts with an EMPTY history in both wirings (`{ messages: [] }`, history replay deferred), so it does not see the message that triggered the handoff. |
| `@theokit/sdk-pty` | `PtyInteractiveBackend` — `node-pty`-backed `InteractiveProvider` for the interactive-shell tools. Opt-in; isolates the native module so core/`sdk-tools` stay surface-agnostic (terminal / desktop / cluster). |

### Memory adapters — external memory backends

| Package | Purpose |
|---|---|
| `@theokit/memory-honcho` | Honcho.dev memory backend. |
| `@theokit/memory-mem0` | mem0.ai memory backend. |
| `@theokit/memory-supermemory` | supermemory.ai memory backend. |

### Integrations — protocol adapters + tooling

| Package | Purpose |
|---|---|
| `@theokit/acp` | Agent Client Protocol (ACP) server adapter. |
| `@theokit/cli` | `theokit` CLI binary (init, dev, inspect, eval, acp). |
| `@theokit/codemod-sdk-2-0` | **DEPRECATED (archived 2026-07-09)** — codemod for an abandoned `@theokit/sdk` → `@theokit/sdk-core` rename; `@theokit/sdk-core` never shipped (npm 404). Do not use. |
| `@theokit/codemod-sdk-3-0` | Consumer migration codemod for the SDK 2.x → 3.0 SE36 rename (`defineTool`/`createSquad`/… → `X.create`). jscodeshift-based. |
| `@theokit/sdk-peer-integration-tests` | **Private, test-only (not published).** Integration tests for `@theokit/sdk` ↔ `@theokit/sdk-memory` peer routing. Lives outside `@theokit/sdk` so the core does not devDepend on its own satellite (breaks the turbo build-ordering cycle; SE43 DoD#3). |

## Extracted to sibling repos (2026-06-18)

These clusters left the Harness monorepo (history-preserving `git filter-repo`). They consume `@theokit/sdk` as a published npm dependency.

| Cluster | New repo | Packages |
|---|---|---|
| Backend-DX | `theokit-di` | `@theokit/di`, `@theokit/di-agent`, `@theokit/orm` |
| Gateways | `theokit-gateways` | `@theokit/gateway` + `gateway-{telegram,discord,slack,whatsapp,teams,email,sms,line,matrix,mattermost}` |
| React | `theokit-react` | `@theokit/react` |
| RAG | `theokit-rag` | `@theokit/rag` (was `@theokit/sdk/rag`) |
| Voice | `theokit-voice` | `@theokit/voice` (was embedded in the SDK) |
| Skills (Google Workspace) | `theokit-skills-google-workspace` → Skills pillar | `@theokit/skills-google-workspace` |

## SDK 2.0 split status

The earlier "SDK 2.0 package split" extracted the `@theokit/sdk-*` extensions out of the kernel. That work is reflected in the Core family above; the cohesion split (2026-06-18) then removed the non-Harness clusters entirely. Historical status table:

| Phase | Task | Status |
|---|---|---|
| 0 | Baseline subsystem map + bundle snapshot | ✅ DONE |
| 1 | Extract `@theokit/sdk-memory` | ✅ DONE |
| 2 | Extract `@theokit/sdk-budget` | ✅ DONE |
| 3 | Extract `@theokit/sdk-cache` | ✅ DONE |
| 4 | Extract `@theokit/sdk-handoff` | ✅ DONE |
| 5 | Extract `@theokit/sdk-tools` | ✅ DONE |
| 6 | Rename `@theokit/sdk` → `@theokit/sdk-core` | ⏳ deferred (not required by cohesion split) |
| 7 | Cohort bump dependent packages | ⏳ operator step |
| 8 | Codemod jscodeshift | ✅ DONE |
| 9 | Documentation (this file) | ✅ DONE |
| 10 | CI bundle budget gate | ✅ DONE |

## License

Apache-2.0.
